import { Client } from "pg";

export default {
  async fetch(request, env) {
    try {
      const client = new Client({
        connectionString: env.HYPERDRIVE.connectionString,
      });

      await client.connect();

      const result = await client.query(`
        SELECT current_database() AS database,
               NOW() AS server_time
      `);

      await client.end();

      return Response.json({
        status: "success",
        message: "Connected to PostgreSQL!",
        data: result.rows,
      });
    } catch (error) {
      return Response.json(
        {
          status: "error",
          message: error.message,
        },
        { status: 500 }
      );
    }
  },
};
