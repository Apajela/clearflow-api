import { Client } from "pg";
import {
  login,
  authenticate,
  logout,
  verifyCurrentPassword,
  bootstrapFirstAdmin
} from "./auth.js";

const FRONTEND_ORIGIN =
  "https://clearflow-hcirms.paguyoddon.workers.dev";

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...extraHeaders
    }
  });
}

function corsHeaders(origin) {
  if (origin !== FRONTEND_ORIGIN) return {};

  return {
    "Access-Control-Allow-Origin": FRONTEND_ORIGIN,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, X-CSRF-Protection",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function toCamelCase(row) {
  const converted = {};

  for (const key in row) {
    const newKey = key.replace(
      /_([a-z])/g,
      (_, letter) => letter.toUpperCase()
    );

    converted[newKey] = row[key];
  }

  return converted;
}

async function readJson(request) {
  if (!request.headers.get("Content-Type")?.includes("application/json")) {
    throw new Error("Invalid content type");
  }

  const text = await request.text();

  if (text.length > 16000) {
    throw new Error("Request too large");
  }

  return JSON.parse(text);
}

function validMutationRequest(request) {
  return (
    request.headers.get("Origin") === FRONTEND_ORIGIN &&
    request.headers.get("X-CSRF-Protection") === "1" &&
    request.headers.get("Content-Type")?.includes("application/json")
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const headers = corsHeaders(origin);

    if (origin && origin !== FRONTEND_ORIGIN) {
      return json(
        { status: "error", message: "Origin not allowed" },
        403
      );
    }

    if (request.method === "OPTIONS") {
      if (origin !== FRONTEND_ORIGIN) {
        return new Response(null, { status: 403 });
      }

      return new Response(null, {
        status: 204,
        headers
      });
    }

    if (url.pathname === "/" && request.method === "GET") {
      return json({
        status: "success",
        message: "ClearFlow Inventory API is running"
      }, 200, headers);
    }

    const isPost = request.method === "POST";

    if (!["GET", "POST"].includes(request.method)) {
      return json(
        { status: "error", message: "Method not allowed" },
        405,
        headers
      );
    }

    if (isPost && !validMutationRequest(request)) {
      return json(
        { status: "error", message: "Request verification failed" },
        403,
        headers
      );
    }

    let client;

    try {
      if (!env.HYPERDRIVE?.connectionString) {
        throw new Error("Database configuration unavailable");
      }

      client = new Client({
        connectionString: env.HYPERDRIVE.connectionString
      });

      await client.connect();

      // POST /api/auth/login
      if (url.pathname === "/api/auth/login" && isPost) {
        const body = await readJson(request);

        const result = await login(
          client,
          body.username,
          body.password
        );

        if (!result) {
          return json(
            { status: "error", message: "Invalid username or password" },
            401,
            headers
          );
        }

        return json({
          status: "success",
          user: result.user
        }, 200, {
          ...headers,
          "Set-Cookie": result.cookie
        });
      }

      // POST /api/auth/logout
      if (url.pathname === "/api/auth/logout" && isPost) {
        const cookie = await logout(client, request);

        return json({
          status: "success",
          message: "Logged out"
        }, 200, {
          ...headers,
          "Set-Cookie": cookie
        });
      }

      // GET /api/auth/me
      if (url.pathname === "/api/auth/me" && request.method === "GET") {
        const user = await authenticate(client, request);

        if (!user) {
          return json(
            { status: "error", message: "Authentication required" },
            401,
            headers
          );
        }

        return json({
          status: "success",
          user
        }, 200, headers);
      }

      // POST /api/auth/verify-password
      if (url.pathname === "/api/auth/verify-password" && isPost) {
        const user = await authenticate(client, request);

        if (!user) {
          return json(
            { status: "error", message: "Authentication required" },
            401,
            headers
          );
        }

        const body = await readJson(request);
        const verified = await verifyCurrentPassword(
          client,
          user.id,
          body.password
        );

        if (!verified) {
          return json(
            { status: "error", message: "Password verification failed" },
            401,
            headers
          );
        }

        return json(
          { status: "success", verified: true },
          200,
          headers
        );
      }

      // POST /api/auth/bootstrap
      if (url.pathname === "/api/auth/bootstrap" && isPost) {
        if (
          typeof env.INITIAL_ADMIN_BOOTSTRAP_TOKEN !== "string" ||
          env.INITIAL_ADMIN_BOOTSTRAP_TOKEN.length < 32
        ) {
          return json(
            { status: "error", message: "Bootstrap is unavailable" },
            403,
            headers
          );
        }

        const body = await readJson(request);

        await bootstrapFirstAdmin(client, {
          bootstrapToken: body.bootstrapToken,
          expectedToken: env.INITIAL_ADMIN_BOOTSTRAP_TOKEN,
          username: body.username,
          password: body.password,
          fullName: body.fullName,
          email: body.email || "",
          department: body.department || ""
        });

        const result = await login(
          client,
          body.username,
          body.password
        );

        if (!result) {
          return json(
            {
              status: "error",
              message: "Administrator created; login must be retried"
            },
            500,
            headers
          );
        }

        return json({
          status: "success",
          user: result.user
        }, 200, {
          ...headers,
          "Set-Cookie": result.cookie
        });
      }

      // All inventory read endpoints require a valid session.
      const protectedPaths = [
        "/api/items",
        "/api/batches",
        "/api/transactions"
      ];

      if (protectedPaths.includes(url.pathname)) {
        if (request.method !== "GET") {
          return json(
            { status: "error", message: "Method not allowed" },
            405,
            headers
          );
        }

        const user = await authenticate(client, request);

        if (!user) {
          return json(
            { status: "error", message: "Authentication required" },
            401,
            headers
          );
        }

        let result;

        if (url.pathname === "/api/items") {
          result = await client.query(`
            SELECT *
            FROM medical_items
            ORDER BY id
          `);
        } else if (url.pathname === "/api/batches") {
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
        } else {
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

        const data = result.rows.map(toCamelCase);

        return json({
          status: "success",
          count: data.length,
          data
        }, 200, headers);
      }

      return json(
        { status: "error", message: "Endpoint not found" },
        404,
        headers
      );

    } catch (error) {
      console.error("ClearFlow API request failed:", error);

      return json(
        { status: "error", message: "Request could not be completed" },
        500,
        headers
      );

    } finally {
      if (client) {
        await client.end().catch(() => {});
      }
    }
  }
};
