const { neon } = require('@neondatabase/serverless');

// Lazily create a single Neon SQL client, reused across invocations within
// the same warm serverless instance. Throws clearly if DATABASE_URL hasn't
// been configured yet in Vercel's environment variables.
let sql;
function getDb() {
    if (!sql) {
        if (!process.env.DATABASE_URL) {
            throw new Error('DATABASE_URL is not set in environment variables');
        }
        sql = neon(process.env.DATABASE_URL);
    }
    return sql;
}

module.exports = { getDb };
