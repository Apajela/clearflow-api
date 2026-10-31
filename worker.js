import { Client } from "pg";

export default {
  async fetch(request, env) {
    try {
      const client = new Client({
        connectionString: env.HYPERDRIVE.connectionStringimport { Client } from "pg";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Allow website/frontend to call this API
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json",
    };

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          ...corsHeaders,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    try {
      const client = new Client({
        connectionString: env.HYPERDRIVE.connectionString,
      });

      await client.connect();

      // GET /api/items
      if (url.pathname === "/api/items" && request.method === "GET") {
        const result = await client.query(`
          SELECT *
          FROM medical_items
          ORDER BY id
        `);

        await client.end();

        return new Response(
          JSON.stringify({
            status: "success",
            count: result.rows.length,
            data: result.rows,
          }),
          { headers: corsHeaders }
        );
      }

      await client.end();

      // API home
      return new Response(
        JSON.stringify({
          status: "success",
          message: "ClearFlow Inventory API is running",
          endpoints: ["/api/items"],
        }),
        { headers: corsHeaders }
      );

    } catch (error) {
      return new Response(
        JSON.stringify({
          status: "error",
          message: error.message,
        }),
        {
          status: 500,
          headers: corsHeaders,
        }
      );
    }
  },
};
