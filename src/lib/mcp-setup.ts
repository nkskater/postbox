/** Setup instructions for MCP clients. They never contain a real token. */
export function setupSnippets(endpoint: string, authRequired: boolean) {
  const header = authRequired ? ` --header "Authorization: Bearer YOUR_TOKEN"` : "";
  return {
    claudeCode: `claude mcp add --transport http postbox ${endpoint}${header}`,
    cursor: JSON.stringify(
      {
        mcpServers: {
          postbox: {
            url: endpoint,
            ...(authRequired ? { headers: { Authorization: "Bearer YOUR_TOKEN" } } : {}),
          },
        },
      },
      null,
      2,
    ),
    openWebUi: [
      "Admin Settings → External Tools → add a server",
      "Type: MCP (Streamable HTTP)",
      `URL: ${endpoint}`,
      ...(authRequired ? ["Auth: Bearer, token: YOUR_TOKEN"] : []),
    ].join("\n"),
  };
}
