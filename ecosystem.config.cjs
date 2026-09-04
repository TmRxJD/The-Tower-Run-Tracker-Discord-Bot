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
        // getaddrinfo runs on the libuv threadpool, which defaults to 4 threads. The bulk
        // import fetches several pages at once, so DNS lookups queued behind each other and
        // contributed to the ENOTFOUND storms in the logs.
        UV_THREADPOOL_SIZE: '16',
      },
    },
  ],
}