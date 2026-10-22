/** PM2 process file for Kipit API + background worker. */
module.exports = {
  apps: [
    {
      name: "kipit-api",
      cwd: __dirname,
      script: "dist/index.js",
      instances: 1,
      exec_mode: "fork",
      env: { NODE_ENV: "production" },
      max_memory_restart: "512M",
    },
    {
      name: "kipit-worker",
      cwd: __dirname,
      script: "dist/worker.js",
      instances: 1,
      exec_mode: "fork",
      env: { NODE_ENV: "production" },
      max_memory_restart: "512M",
    },
  ],
};
