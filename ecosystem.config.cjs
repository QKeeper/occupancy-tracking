module.exports = {
  apps: [
    {
      name: "occupancy-tracking",
      script: "server/index.ts",
      interpreter: "pnpm",
      interpreter_args: "exec tsx",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
