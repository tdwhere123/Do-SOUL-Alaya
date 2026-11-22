import { expect, it } from "vitest";
import { stableCanonicalStringify } from "../../../recall/conditional-field/product-identity.js";

it("sorts and escapes keys while omitting undefined object fields", () => {
  const identity = stableCanonicalStringify({
    z: { absent: undefined, 'a"b': "value" },
    a: null,
    absent: undefined
  });

  expect(identity).toBe('{"a":null,"z":{"a\\"b":"value"}}');
});

it("distinguishes punctuation in a key from object structure", () => {
  expect(stableCanonicalStringify({ "a:1,b": 2 })).not.toBe(stableCanonicalStringify({ a: 1, b: 2 }));
});
