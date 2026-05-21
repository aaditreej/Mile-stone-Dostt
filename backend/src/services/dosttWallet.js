const axios = require("axios");
const FormData = require("form-data");

async function creditCoins(dosttUserId, tierId, coins) {
  const url     = process.env.DOSTT_WALLET_API_URL;
  const authKey = process.env.DOSTT_WALLET_AUTH_KEY;

  if (!url || !authKey) {
    throw new Error("DOSTT_WALLET_API_URL / DOSTT_WALLET_AUTH_KEY not set");
  }
  if (!dosttUserId) {
    throw new Error(`Cannot credit wallet — dostt_user_id is null for tier ${tierId}`);
  }

  const csv = `user_id,coins\n${dosttUserId},${coins}\n`;

  const form = new FormData();
  form.append("file", Buffer.from(csv), {
    filename: "coins_batch.csv",
    contentType: "text/csv",
  });
  form.append("name", "Dostt free Rewards");

  const response = await axios.post(url, form, {
    headers: {
      ...form.getHeaders(),
      "x-n8n-auth-key": authKey,
    },
    timeout: 20_000,
  });

  const data = response.data;

  // Validate that the wallet API actually succeeded.
  // The API may return HTTP 200 with an error body — treat that as a failure
  // so the claim is rolled back and the user can retry rather than silently
  // receiving no coins.
  if (data && typeof data === "object") {
    const hasErrorFlag =
      data.success === false ||
      data.status  === "error" ||
      data.status  === "failed" ||
      data.error   === true     ||
      (typeof data.error === "string" && data.error.length > 0);

    if (hasErrorFlag) {
      const reason = data.message || data.error || data.reason || JSON.stringify(data);
      throw new Error(`Wallet API returned failure: ${reason}`);
    }
  }

  return data;
}

module.exports = { creditCoins };
