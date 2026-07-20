import assert from "node:assert/strict";
import test from "node:test";
import { OtApiProvider } from "./providers/otapi.provider";
import { ProviderUpstreamError } from "./providers/provider";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_INSTANCE_KEY = process.env.OTAPI_INSTANCE_KEY;

function response(searchMethod = "Storage"): Response {
  return new Response(
    JSON.stringify({
      ErrorCode: "Ok",
      Result: {
        Items: {
          Provider: "Taobao",
          SearchMethod: searchMethod,
          Items: {
            TotalCount: 2,
            Content: [
              {
                Id: "tmall-1",
                Title: "Tmall item",
                ExternalItemUrl: "https://detail.tmall.com/item.htm?id=1",
                Features: ["Tmall"],
              },
              {
                Id: "taobao-1",
                Title: "Taobao item",
                ExternalItemUrl: "https://item.taobao.com/item.htm?id=1",
                Features: [],
              },
            ],
          },
        },
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

test("invia e verifica il filtro Tmall, poi lo riapplica alla risposta", async () => {
  process.env.OTAPI_INSTANCE_KEY = "test-key";
  let requestedUrl = "";
  globalThis.fetch = (async (input) => {
    requestedUrl = String(input);
    return response();
  }) as typeof fetch;

  try {
    const provider = new OtApiProvider({
      name: "tmall",
      provider: "Taobao",
      searchMethod: "Storage",
      expectedSearchMethod: "Storage",
      featureFilters: { Tmall: true },
    });
    const result = await provider.search({
      query: "powerbank",
      framePosition: 0,
      frameSize: 20,
      sort: "default",
    });

    const xml = new URL(requestedUrl).searchParams.get("xmlParameters") ?? "";
    assert.match(xml, /<SearchMethod>Storage<\/SearchMethod>/);
    assert.match(xml, /<Feature Name="Tmall">true<\/Feature>/);
    assert.deepEqual(result.items.map((item) => item.id), ["tmall-1"]);
    assert.deepEqual(result.items[0]?.sourceFeatures, ["Tmall"]);
  } finally {
    globalThis.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_INSTANCE_KEY === undefined) delete process.env.OTAPI_INSTANCE_KEY;
    else process.env.OTAPI_INSTANCE_KEY = ORIGINAL_INSTANCE_KEY;
  }
});

test("rifiuta una sostituzione silenziosa del metodo OTAPI", async () => {
  process.env.OTAPI_INSTANCE_KEY = "test-key";
  globalThis.fetch = (async () => response("Default")) as typeof fetch;
  try {
    const provider = new OtApiProvider({
      searchMethod: "Storage",
      expectedSearchMethod: "Storage",
    });
    await assert.rejects(
      provider.search({
        query: "mug",
        framePosition: 0,
        frameSize: 20,
        sort: "default",
      }),
      ProviderUpstreamError
    );
  } finally {
    globalThis.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_INSTANCE_KEY === undefined) delete process.env.OTAPI_INSTANCE_KEY;
    else process.env.OTAPI_INSTANCE_KEY = ORIGINAL_INSTANCE_KEY;
  }
});
