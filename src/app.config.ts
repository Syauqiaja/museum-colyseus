import {
    defineServer,
    defineRoom,
    monitor,
    playground,
    createRouter,
    createEndpoint,
} from "colyseus";

/**
 * Import your Room files
 */
import { DakonRoom } from "./rooms/DakonRoom.js";
import { EgrangRoom } from "./rooms/EgrangRoom.js";
import { MuseumRoom } from "./rooms/MuseumRoom.js";
import { clearLiveSessions } from "./db/sessions.js";

const server = defineServer({
    /**
     * Define your room handlers:
     */
    rooms: {
        dakon: defineRoom(DakonRoom),
        egrang: defineRoom(EgrangRoom),
        // Presence only — the hub relays visitor positions and holds no match.
        museum: defineRoom(MuseumRoom),
    },

    /**
     * Runs once before the server accepts connections. `live_sessions` rows
     * describe live sockets, and no socket survives a restart — anything left in
     * there is from the previous process. See docs/database.md.
     */
    beforeListen: async () => {
        await clearLiveSessions();
    },

    /**
     * Experimental: Define API routes. Built-in integration with the "playground" and SDK.
     * 
     * Usage from SDK: 
     *   client.http.get("/api/hello").then((response) => {})
     * 
     */
    routes: createRouter({
        api_hello: createEndpoint("/api/hello", { method: "GET", }, async (ctx) => {
            return { message: "Hello World" }
        })
    }),

    /**
     * Bind your custom express routes here:
     * Read more: https://expressjs.com/en/starter/basic-routing.html
     */
    express: (app) => {
        app.get("/hi", (req, res) => {
            res.send("It's time to kick ass and chew bubblegum!");
        });

        /**
         * Use @colyseus/monitor
         *
         * The panel lists every live room and can forcibly dispose them, so it
         * stays off unless explicitly switched on. Enable per-environment with
         * MONITOR_ENABLED=1, and put HTTP basic auth in front of it at the
         * reverse proxy (see deploy/nginx/museumethnofun.com.conf).
         *
         * Read more: https://docs.colyseus.io/tools/monitoring/#restrict-access-to-the-panel-using-a-password
         */
        if (process.env.MONITOR_ENABLED === "1") {
            app.use("/monitor", monitor());
        }

        /**
         * Use @colyseus/playground
         * (It is not recommended to expose this route in a production environment)
         */
        if (process.env.NODE_ENV !== "production") {
            app.use("/", playground());
        }
    }

});

export default server;