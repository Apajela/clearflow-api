import { Client } from "pg";

export default {
  async fetch(request, env) {
    try {
      const client = new Client({
        connectionString: env.HYPERDRIVE.connectionString,
      });

      await client.connect();

     const result = await client.query(`
  SELECT table_name
  FROM information_schema.tables
  WHERE table_schema = 'public'
  ORDER BY table_name
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
