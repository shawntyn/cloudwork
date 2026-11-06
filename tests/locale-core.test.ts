import test from "node:test";
import assert from "node:assert/strict";
import { acceptLanguages, resolveLocale } from "../apps/web/components/locale-core.ts";

test("automatic locale honors browser language priority and falls back to Chinese", () => {
    assert.equal(resolveLocale("auto", ["en-US", "zh-CN"]), "en");
    assert.equal(resolveLocale("auto", ["fr-FR", "zh-TW", "en-US"]), "zh-CN");
    assert.equal(resolveLocale("auto", ["fr-FR", "de-DE"]), "zh-CN");
    assert.equal(resolveLocale("en", ["zh-CN"]), "en");
});

test("Accept-Language quality determines the first supported locale", () => {
    assert.deepEqual(acceptLanguages("en-US;q=0.7, zh-CN;q=0.9, fr;q=0"), ["zh-CN", "en-US"]);
    assert.deepEqual(acceptLanguages("en-US; q=0.7, zh-CN; q=0.9"), ["zh-CN", "en-US"]);
    assert.equal(resolveLocale("auto", acceptLanguages("fr, en;q=0.8, zh;q=0.7")), "en");
});
