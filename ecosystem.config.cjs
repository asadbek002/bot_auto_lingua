module.exports = {
  apps: [
    {
      name: "lingua-agent",
      script: "dist/index.js",
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
      watch: false,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
