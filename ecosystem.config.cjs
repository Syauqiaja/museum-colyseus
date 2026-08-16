/**
 * PM2 process config for the self-hosted VPS deployment.
 *
 * NOT the Colyseus Cloud layout. Two deliberate differences from the template
 * this file started as:
 *
 *  1. `instances: 1`. The template used `os.cpus().length`. Colyseus only wires
 *     up a shared Redis presence/driver when COLYSEUS_CLOUD is set (see
 *     @colyseus/tools getColyseusCloudConfig), so on a self-hosted box N
 *     processes on one port each keep a private room registry — a player who
 *     lands on process 2 cannot see or join a room created on process 1.
 *     Raising this requires @colyseus/redis-presence + @colyseus/redis-driver
 *     and a REDIS_URI first.
 *
 *  2. `NODE_ENV: "production"`. @colyseus/tools loads `.env.${NODE_ENV}`, so
 *     this is also what makes `.env.production` take effect. It additionally
 *     switches off the /playground route in src/app.config.ts.
 */

module.exports = {
  apps: [{
    name: "colyseus-app",
    script: "build/index.js",
    time: true,
    watch: false,
    instances: 1,
    exec_mode: "fork",
    wait_ready: true,
    env: {
      NODE_ENV: "production",
    },
  }],
};
