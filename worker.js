import { Client } from "pg";

function toCamelCase(row) {
  const converted = {};

  for (const key in row) {
    const newKey = key.replace(/_([a-z])/g, (_, letter) =>
      letter.toUpperCase()
    );

    converted[newKey] = row[key];
  }

  return converted;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          ...corsHeaders,
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (request.method !== "GET") {
      return new Response(
        JSON.stringify({
          status: "error",
          message: "Method not allowed",
        }),
        { status: 405, headers: corsHeaders }
      );
    }

    let client;

    try {
      client = new Client({
        connectionString: env.HYPERDRIVE.connectionString,
      });

      await client.connect();

      let result;

      // GET /api/items
      if (url.pathname === "/api/items") {
        result = await client.query(`
          SELECT *
          FROM medical_items
          ORDER BY id
        `);
      }

      // GET /api/batches
      else if (url.pathname === "/api/batches") {
        result = await client.query(`
          SELECT
            bl.*,
            mi.item_code,
            mi.name
          FROM batch_lots bl
          LEFT JOIN medical_items mi
            ON bl.item_id = mi.id
          ORDER BY bl.expiry_date ASC NULLS LAST
        `);
      }

      // GET /api/transactions
      else if (url.pathname === "/api/transactions") {
        result = await client.query(`
          SELECT
            it.*,
            mi.item_code,
            mi.name,
            bl.batch_number
          FROM inventory_transactions it
          LEFT JOIN medical_items mi
            ON it.item_id = mi.id
          LEFT JOIN batch_lots bl
            ON it.batch_id = bl.id
          ORDER BY it.created_at DESC
        `);
      }

      // API home
      else if (url.pathname === "/") {
        return new Response(
          JSON.stringify({
            status: "success",
            message: "ClearFlow Inventory API is running",
            endpoints: [
              "/api/items",
              "/api/batches",
              "/api/transactions",
            ],
          }),
          { headers: corsHeaders }
        );
      }

      // Unknown endpoint
      else {
        return new Response(
          JSON.stringify({
            status: "error",
            message: "Endpoint not found",
          }),
          { status: 404, headers: corsHeaders }
        );
      }

      const data = result.rows.map(toCamelCase);

      return new Response(
        JSON.stringify({
          status: "success",
          count: data.length,
          data: data,
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
    } finally {
      if (client) {
        await client.end().catch(() => {});
      }
    }
  },
};
