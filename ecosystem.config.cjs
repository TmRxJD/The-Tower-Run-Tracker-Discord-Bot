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
        // dns.lookup, sqlite3 and async fs share libuv's 4 default threads; a busy sqlite
        // queue can otherwise delay the DNS lookup behind a fresh Discord connection.
        UV_THREADPOOL_SIZE: 16,
        NODE_ENV: 'development',
        DEPLOYMENT_MODE: 'dev',
      },
      env_production: {
        UV_THREADPOOL_SIZE: 16,
        NODE_ENV: 'production',
        DEPLOYMENT_MODE: 'prod',
      },
    },
  ],
}