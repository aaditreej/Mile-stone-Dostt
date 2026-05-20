/**
 * Redash API client.
 *
 * Handles the async job pattern automatically:
 *   runQuery(queryId, params?, maxAge?) → array of result rows
 *
 * Set env vars:
 *   REDASH_BASE_URL   e.g. https://app.redash.io/yourslug
 *   REDASH_API_KEY    Query API key (preferred) or User API key
 */

const axios = require("axios");

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS  = 60_000;

function client() {
  return axios.create({
    baseURL: process.env.REDASH_BASE_URL,
    headers: { Authorization: `Key ${process.env.REDASH_API_KEY}` },
    timeout: 15_000,
  });
}

/**
 * Poll a job until it's done or times out.
 * @returns {Promise<number>} query_result_id
 */
async function pollJob(jobId) {
  const http    = client();
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const { data } = await http.get(`/api/jobs/${jobId}`);
    const { status, query_result_id, error } = data.job;

    if (status === 3) return query_result_id;   // SUCCESS
    if (status === 4) throw new Error(`Redash job failed: ${error}`);
    if (status === 5) throw new Error("Redash job was cancelled");

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error(`Redash job ${jobId} timed out after ${POLL_TIMEOUT_MS}ms`);
}

/**
 * Execute a Redash query and return its rows.
 *
 * @param {number}  queryId   - Redash query ID
 * @param {object}  [params]  - parameter values (for parameterised queries)
 * @param {number}  [maxAge]  - cache TTL in seconds (0 = always fresh)
 * @returns {Promise<object[]>}
 */
async function runQuery(queryId, params = {}, maxAge = 1800) {
  const http = client();

  const body = { max_age: maxAge };
  if (Object.keys(params).length) body.parameters = params;

  const { data } = await http.post(`/api/queries/${queryId}/results`, body);

  // If Redash returned a cached result immediately
  if (data.query_result) {
    return data.query_result.data.rows;
  }

  // Otherwise poll the async job
  if (data.job) {
    const resultId = await pollJob(data.job.id);
    const { data: result } = await http.get(`/api/query_results/${resultId}.json`);
    return result.query_result.data.rows;
  }

  throw new Error("Unexpected Redash response shape");
}

module.exports = { runQuery };
