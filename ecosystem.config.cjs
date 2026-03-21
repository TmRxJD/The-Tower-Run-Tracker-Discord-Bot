module.exports = {
  apps: [
    {
      name: 'trackerbot',
      script: 'dist/bot.js',
      cwd: __dirname,
      interpreter: 'node',
      exec_mode: 'fork',
      watch: false,
      env: {
        NODE_ENV: 'development',
        DEPLOYMENT_MODE: 'dev',
      },
      env_production: {
        NODE_ENV: 'production',
        DEPLOYMENT_MODE: 'prod',
      },
    },
  ],
}