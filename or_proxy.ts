import express from "express";
import type { Request, Response } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import axios from "axios";

const PORT = Number(process.env.PORT) || 3001;
const UPSTREAM_HOST = "openrouter.ai";
const UPSTREAM_URL = `https://${UPSTREAM_HOST}/api/v1/chat/completions`;

type CacheControl =
    | { type: "ephemeral"; ttl: "1h" }
    | { type: "ephemeral" };

interface TextPart {
    type: string;
    text?: string;
    cache_control?: CacheControl;
    [key: string]: unknown;
}

interface Message {
    content: string | TextPart[];
    [key: string]: unknown;
}

export function applyCaching(messageArray: Message[] | undefined, ttl1h: boolean): void {
    if (!Array.isArray(messageArray)) return;
    for (let i = messageArray.length - 1; i >= 0; i--) {
        const content = messageArray[i]["content"];
        const cache_control: CacheControl = ttl1h
            ? { type: "ephemeral", ttl: "1h" }
            : { type: "ephemeral" };
        if (typeof content === "string") {
            messageArray[i]["content"] = [
                {
                    type: "text",
                    text: content,
                    cache_control,
                },
            ];
            return;
        } else if (Array.isArray(content)) {
            for (let j = content.length - 1; j >= 0; j--) {
                if (content[j] && content[j]["type"] === "text") {
                    content[j]["cache_control"] = cache_control;
                    return;
                }
            }
        } else {
            // Unknown message type
        }
    }
}

/**
 * Parse the extended model slug and mutate the request body accordingly.
 * Returns the modified body. Exported so the parsing logic is unit-testable.
 */
export function buildModifiedBody(requestBody: any): any {
    const modifiedBody: any = { ...requestBody };

    const model: string = requestBody.model;
    let slug = model;
    let params: string[] = [];
    const parts = model.split("$");
    if (parts.length > 1) {
        slug = parts[0];
        params = parts[1].split(",");
    }

    for (const param of params) {
        if (
            ["int4", "int8", "fp4", "fp6", "fp8", "fp16", "bf16", "fp32"].includes(param)
        ) {
            // Quantization lock
            if (!("provider" in modifiedBody)) modifiedBody["provider"] = {};
            if (!("quantizations" in modifiedBody.provider)) {
                modifiedBody.provider["quantizations"] = [];
            }
            modifiedBody.provider.quantizations.push(param);
        } else if (param.startsWith("think")) {
            // Thinking options
            if (param.includes(".")) {
                const thinking_option = param.split(".")[1];
                if (["no", "off"].includes(thinking_option)) {
                    modifiedBody["reasoning"] = { enabled: false };
                } else if (isNaN(Number(thinking_option))) {
                    modifiedBody["reasoning"] = {
                        enabled: true,
                        effort: thinking_option,
                    };
                } else {
                    modifiedBody["reasoning"] = {
                        enabled: true,
                        max_tokens: +thinking_option,
                    };
                }
            } else {
                modifiedBody["reasoning"] = { enabled: true };
            }
        } else if (param === "cache") {
            applyCaching(modifiedBody["messages"], false);
        } else if (param === "cache1h") {
            applyCaching(modifiedBody["messages"], true);
        } else if (param === "zdr") {
            // Zero Data Retention endpoint requirement
            if (!("provider" in modifiedBody)) modifiedBody["provider"] = {};
            modifiedBody["provider"]["zdr"] = true;
            modifiedBody["provider"]["data_collection"] = "deny";
        } else if (param === "strict") {
            if (!("provider" in modifiedBody)) modifiedBody["provider"] = {};
            modifiedBody["provider"]["allow_fallbacks"] = false;
        } else if (param.startsWith("tier.")) {
            modifiedBody["service_tier"] = param.split(".")[1];
        } else {
            // If nothing else matches, its a provider name
            if (!("provider" in modifiedBody)) modifiedBody["provider"] = {};
            if (!("order" in modifiedBody.provider)) modifiedBody.provider["order"] = [];
            modifiedBody.provider.order.push(param);
        }
    }
    modifiedBody.model = slug;
    modifiedBody.usage = { include: true };
    return modifiedBody;
}

const app = express();

app.use(express.json({ limit: "10gb" }));
app.use(
    express.urlencoded({
        limit: "10gb",
        extended: true,
        parameterLimit: 10000000,
    })
);

app.post("/:loc/chat/completions", async (req: Request, res: Response) => {
    try {
        const modifiedBody = buildModifiedBody(req.body);

        const headers = { ...req.headers };
        headers["host"] = UPSTREAM_HOST;
        delete headers["content-length"];
        const response = await axios({
            method: "POST",
            url: UPSTREAM_URL,
            data: modifiedBody,
            headers,
            responseType: "stream",
        });
        Object.keys(response.headers).forEach((key) => {
            res.setHeader(key, response.headers[key] as string);
        });
        response.data.on("data", (chunk: Buffer) => {
            res.write(chunk);
        });
        response.data.on("end", () => {
            res.end();
        });
        response.data.on("error", (err: Error) => {
            console.error("Stream error:", err);
            res.status(500).send(`Internal Server Error: ${err.message}`);
        });
    } catch (err: any) {
        console.error(err.message);
        if (err.response) {
            res.status(err.response.status);
            Object.keys(err.response.headers).forEach((key) => {
                res.setHeader(key, err.response.headers[key]);
            });
            err.response.data.pipe(res);
            return;
        }
        return res.status(500).send({
            error: `Internal Server Error: ${err.message}`,
            details: err.message,
        });
    }
});

app.use(
    "/:loc",
    createProxyMiddleware({
        target: `https://${UPSTREAM_HOST}`,
        changeOrigin: true,
        pathRewrite: (path: string) => {
            return "api/v1" + path;
        },
        onError: (err: Error, _req, res: any) => {
            console.error("Proxy error:", err);
            res.status(502).json({ error: "Proxy request failed" });
        },
    })
);

const server = app.listen(PORT, () => {
    console.log(`Proxy server running on port ${PORT}`);
});

function shutdown(signal: string): void {
    console.log(`Received ${signal}, shutting down...`);
    server.close(() => process.exit(0));
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
