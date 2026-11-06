import assert from "node:assert/strict";
import test from "node:test";
import { clientUuid } from "./client-uuid";

test("client UUID uses randomUUID when available", () => {
    const expected = "87d45cf7-4c70-48c8-95cb-3ced96113b9c";
    assert.equal(clientUuid({ randomUUID: () => expected, getRandomValues: () => { throw new Error("fallback should not run"); } }), expected);
});

test("client UUID uses secure random values when randomUUID is unavailable", () => {
    const id = clientUuid({ getRandomValues: bytes => bytes.fill(0xff) });
    assert.equal(id, "ffffffff-ffff-4fff-bfff-ffffffffffff");
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
