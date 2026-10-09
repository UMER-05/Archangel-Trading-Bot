// PM2 configuration for a plain VPS (InterServer, etc.)
//
// exec_mode is deliberately "fork" with a single instance, not "cluster" —
// this app keeps in-memory state (tracked token prices, open positions,
// Socket.IO connections) in module-level Maps. Cluster mode runs multiple
// separate Node processes, each with its own copy of that state, which
// would make position tracking and live broadcasts behave inconsistently
// depending on which worker handled a given request/connection.
module.exports = {
  apps: [
    {
      name: "archangel-backend",
      script: "./dist/index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
        PORT: process.env.PORT || 4000,
      },
      error_file: "./logs/err.log",
      out_file: "./logs/out.log",
      log_file: "./logs/combined.log",
      time: true,
    },
  ],
};
