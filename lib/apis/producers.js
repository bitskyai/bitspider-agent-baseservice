const http = require("../utils/http");
const constants = require("../utils/constants");

async function getAgentAPI(baseURL, gid, type, securityKey, context) {
  try {
    let headers = {};
    let url = new URL(`/apis/producers/${gid}`, baseURL).toString();
    if (securityKey) {
      headers[constants.X_SECURITY_KEY_HEADER] = securityKey;
    }
    let result = await http(
      {
        url,
        params: {
          type
        },
        method: "GET",
        headers,
      },
      context
    );
    return result.data;
  } catch (err) {
    throw err;
  }
}

async function updateAgentAPI(baseURL, agent, context) {
  try {
    let url = new URL(`/apis/producers/${agent.globalId}`, baseURL).toString();
    let result = await http(
      {
        url,
        method: "PUT",
        data: agent,
      },
      context
    );
    return result.data;
  } catch (err) {
    throw err;
  }
}

module.exports = {
  getAgentAPI,
  updateAgentAPI,
};