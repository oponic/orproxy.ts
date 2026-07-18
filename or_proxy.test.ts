import { test, expect } from "bun:test";
import { buildModifiedBody, applyCaching } from "./or_proxy";

test("plain model slug is passed through with usage enabled", () => {
    const out = buildModifiedBody({ model: "openai/gpt-5.5", messages: [] });
    expect(out.model).toBe("openai/gpt-5.5");
    expect(out.usage).toEqual({ include: true });
    expect(out.provider).toBeUndefined();
});

test("quantization params accumulate under provider.quantizations", () => {
    const out = buildModifiedBody({ model: "moonshotai/kimi-k2$fp8,fp16" });
    expect(out.model).toBe("moonshotai/kimi-k2");
    expect(out.provider.quantizations).toEqual(["fp8", "fp16"]);
});

test("thinking options parse effort, max_tokens, and off", () => {
    expect(buildModifiedBody({ model: "m$think" }).reasoning).toEqual({ enabled: true });
    expect(buildModifiedBody({ model: "m$think.high" }).reasoning).toEqual({
        enabled: true,
        effort: "high",
    });
    expect(buildModifiedBody({ model: "m$think.1000" }).reasoning).toEqual({
        enabled: true,
        max_tokens: 1000,
    });
    expect(buildModifiedBody({ model: "m$think.off" }).reasoning).toEqual({
        enabled: false,
    });
});

test("service tier and unknown params (provider order)", () => {
    const out = buildModifiedBody({ model: "openai/gpt-5.5$openai,tier.flex" });
    expect(out.service_tier).toBe("flex");
    expect(out.provider.order).toEqual(["openai"]);
});

test("zdr and strict set provider flags", () => {
    const out = buildModifiedBody({ model: "m$zdr,strict" });
    expect(out.provider.zdr).toBe(true);
    expect(out.provider.data_collection).toBe("deny");
    expect(out.provider.allow_fallbacks).toBe(false);
});

test("cache converts trailing string content into a cached text part", () => {
    const messages = [
        { role: "system", content: "sys" },
        { role: "user", content: "hello" },
    ];
    applyCaching(messages, true);
    expect(messages[1].content).toEqual([
        { type: "text", text: "hello", cache_control: { type: "ephemeral", ttl: "1h" } },
    ]);
    // earlier message untouched
    expect(messages[0].content).toBe("sys");
});
