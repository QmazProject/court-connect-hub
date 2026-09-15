/**
 * The PayMongo Money Movement client: the right endpoint, the right auth, the
 * documented body, and errors turned into codes an attempt row can keep.
 *
 * `fetch` is stubbed; nothing here reaches the network. The secret key is a
 * fake set for the test and read only by the module under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

beforeEach(() => {
  process.env.PAYMONGO_SECRET_KEY = "sk_test_fake_key_for_tests";
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const reply = (status: number, body: unknown) =>
  Promise.resolve({ ok: status < 400, status, text: () => Promise.resolve(JSON.stringify(body)) });

describe("createOutwardTransfer", () => {
  it("POSTs one transfer to /v2/batch_transfers with Basic auth and returns the transfer", async () => {
    const { createOutwardTransfer } = await import("../paymongo.server");
    fetchMock.mockReturnValueOnce(
      reply(201, {
        data: {
          id: "batch_tr_1",
          transfers: [
            {
              id: "tr_1",
              status: "pending",
              provider: "instapay",
              amount: 1000,
              currency: "PHP",
              reference_number: "CCH P1 A1",
            },
          ],
        },
      }),
    );
    const body = { provider: "instapay", amount: 1000, currency: "PHP" };
    const r = await createOutwardTransfer(body);

    expect(r.batchId).toBe("batch_tr_1");
    expect(r.transfer.id).toBe("tr_1");
    expect(r.transfer.status).toBe("pending");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.paymongo.com/v2/batch_transfers");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      "Basic " + Buffer.from("sk_test_fake_key_for_tests:").toString("base64"),
    );
    expect(JSON.parse(init.body as string)).toEqual({ transfers: [body] });
  });

  it("turns a PayMongo refusal into a typed error with the code and detail", async () => {
    const { createOutwardTransfer, PaymongoRequestError } = await import("../paymongo.server");
    fetchMock.mockReturnValueOnce(
      reply(400, {
        errors: [{ code: "insufficient_balance", detail: "Wallet balance is insufficient." }],
      }),
    );
    await expect(createOutwardTransfer({})).rejects.toBeInstanceOf(PaymongoRequestError);
    fetchMock.mockReturnValueOnce(
      reply(400, {
        errors: [{ code: "insufficient_balance", detail: "Wallet balance is insufficient." }],
      }),
    );
    try {
      await createOutwardTransfer({});
    } catch (e) {
      const err = e as InstanceType<typeof PaymongoRequestError>;
      expect(err.status).toBe(400);
      expect(err.code).toBe("insufficient_balance");
      expect(err.detail).toBe("Wallet balance is insufficient.");
    }
  });

  it("a 201 with no transfer inside is an error, not a silent success", async () => {
    const { createOutwardTransfer } = await import("../paymongo.server");
    fetchMock.mockReturnValueOnce(reply(201, { data: { id: "batch_tr_1", transfers: [] } }));
    await expect(createOutwardTransfer({})).rejects.toThrow(/no transfer/);
  });
});

describe("retrieveTransfer and listWallets", () => {
  it("GET /v2/transfers/{id}", async () => {
    const { retrieveTransfer } = await import("../paymongo.server");
    fetchMock.mockReturnValueOnce(
      reply(200, {
        data: { id: "tr_9", status: "succeeded", provider: "instapay", amount: 5, currency: "PHP" },
      }),
    );
    const t = await retrieveTransfer("tr_9");
    expect(t.status).toBe("succeeded");
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      "https://api.paymongo.com/v2/transfers/tr_9",
    );
  });

  it("fills a wallet's source account from GET /v1/wallets/{id} when v2 omits it", async () => {
    const { listWallets } = await import("../paymongo.server");
    fetchMock
      .mockReturnValueOnce(
        reply(200, {
          data: [{ id: "wallet_t", livemode: false, is_default: true, status: "activated" }],
        }),
      )
      .mockReturnValueOnce(
        reply(200, {
          data: {
            id: "wallet_t",
            attributes: {
              account_name: "TEST MERCHANT",
              account_number: "627286493807",
              available_balance: 5000000,
            },
          },
        }),
      );
    const w = await listWallets();
    expect(w[0].account?.account_number).toBe("627286493807");
    expect(w[0].account?.account_name).toBe("TEST MERCHANT");
    expect(w[0].balance?.available).toBe(5000000);
    expect((fetchMock.mock.calls[1] as [string])[0]).toBe(
      "https://api.paymongo.com/v1/wallets/wallet_t",
    );
  });

  it("GET /v2/wallets returns the wallets with their source account", async () => {
    const { listWallets } = await import("../paymongo.server");
    fetchMock.mockReturnValueOnce(
      reply(200, {
        data: [
          {
            id: "wallet_1",
            livemode: false,
            is_default: true,
            status: "activated",
            account: {
              provider: "paymongo",
              account_name: "CC",
              account_number: "0001",
              currency: "PHP",
            },
          },
        ],
      }),
    );
    const w = await listWallets();
    expect(w[0].account?.account_number).toBe("0001");
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      "https://api.paymongo.com/v2/wallets/?fields=account&fields=balance&fields=limits",
    );
  });
});

describe("the key never leaves the server module", () => {
  it("mode is derived from the key prefix and is all the client is ever told", async () => {
    const { paymongoMode } = await import("../paymongo.server");
    expect(paymongoMode()).toBe("test");
  });
});
