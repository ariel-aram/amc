import { default_userAgent_desktop, streamTypeYT, useClientYT, cacheTrackYT, useNativeStream } from "../config.json";
import dotenv from "dotenv";
import ytClients from "./youtubeClients";
import { Logger } from "@tryforge/forgescript";
import { Readable, PassThrough } from "stream";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { Innertube } from "youtubei.js";
import { initBotGuard, mintPoToken, generateAnonPOT, invalidateBotGuard, setAttestationSource } from "./youtubeBG";

const targetClient = useClientYT?.toUpperCase();
const useClient = ytClients?.[targetClient];
if (!useClient) {
    const available = Object.keys(ytClients).join(", ");
    throw new Error(`YouTube client "${targetClient}" does not exist. Available clients: ${available}`);
}

const forceAuthClients = ["WEB_PARENT", "WEB_CREATOR", "ANDROID_VR", "ANDROID_VR_DOWN"];

if (["WEB_CREATOR", "WEB_PARENT"].includes(targetClient) && !process.env.YOUTUBE_COOKIES) {
    throw new Error(`Please put youtube cookies first before using this client. (${targetClient})`);
}

const isWebClient = useClient.targetDomain !== "youtubei.googleapis.com";
const isEmbeddedClient = useClient.embedded === true;
const hostdomain = useClient.targetDomain;
const embedUrl = useClient.embedUrl;
const APIuserAgent = useClient.userAgent || default_userAgent_desktop;

const cacheDir = path.join(__dirname, "ytCacheTracks");
fs.mkdirSync(cacheDir, { recursive: true });

// The client context sent on /player, exactly as configured in youtubeClients.ts.
const { targetDomain: _t, client_id: _ci, client_secret: _cs, embedded: _e, embedUrl: _eu, ...clientContext } = useClient;
const playerClient: Record<string, any> = { ...clientContext, hl: "en", gl: "US" };

let ytauth: any;
let ytcookies: string | undefined;
let tempytcookies: string | undefined;
let ytcookiesapi: string | undefined;
let datasyncID = "";
let authRequiredUntil = 0;

function refreshYtAuth() {
    dotenv.config({ override: true, quiet: true });
    if (process.env.YOUTUBE_AUTH) {
        try { ytauth = JSON.parse(process.env.YOUTUBE_AUTH); } catch { }
    }
    if (process.env.YOUTUBE_COOKIES) ytcookies = process.env.YOUTUBE_COOKIES;
    if (process.env.YOUTUBE_ANONCOOKIES) tempytcookies = process.env.YOUTUBE_ANONCOOKIES;
}
refreshYtAuth();

const isVRAuth = () => !!ytauth?.token && (targetClient === "ANDROID_VR" || targetClient === "ANDROID_VR_DOWN");

function normalizeCookies(cookies: string[] | string | undefined): string {
    if (!cookies) return "";
    const list = Array.isArray(cookies) ? cookies : cookies.split(",");
    return list.map(c => c.trim().split(";")[0]).filter(Boolean).join("; ");
}

function sapisidHash(): string {
    const pick = (name: string) => ytcookies?.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))?.[1];
    const t = Math.floor(Date.now() / 1000).toString();
    const dsi = datasyncID && datasyncID !== "null" && datasyncID.trim() !== "" ? datasyncID + " " : "";
    const origin = `https://${hostdomain}`;
    const hash = (sid: string | undefined) => createHash("sha1").update(`${dsi}${t} ${sid} ${origin}`).digest("hex");
    return `SAPISIDHASH ${t}_${hash(pick("SAPISID"))}_u SAPISID1PHASH ${t}_${hash(pick("__Secure-1PAPISID"))}_u SAPISID3PHASH ${t}_${hash(pick("__Secure-3PAPISID"))}_u`;
}

// sw.js_data gives the dataSyncId used to bind session PoTokens for signed-in
// requests, and the cookies handed to discord-player-youtubei.
async function fetchSwData() {
    try {
        const headers: Record<string, string> = { "User-Agent": default_userAgent_desktop };
        if (ytcookies || tempytcookies) headers.Cookie = ytcookies || tempytcookies;
        const res = await fetch("https://www.youtube.com/sw.js_data", { headers });
        ytcookiesapi = ytcookies || normalizeCookies(res.headers.getSetCookie());
        const data = JSON.parse((await res.text()).split("\n")[2] || "null");
        const rawSync = data?.[0]?.[3];
        datasyncID = typeof rawSync === "string" ? rawSync.split("||")[0] : "";
    } catch (e: any) {
        Logger.info(`/ [YoutubeConfig] sw.js_data unavailable (${e?.message || e})`);
    }
}

let embeddedContext: { thirdParty: any; encryptedHostFlags: any } | null = null;
async function fetchEmbeddedContext(videoId: string) {
    if (!isEmbeddedClient || embeddedContext) return embeddedContext;
    try {
        const headers: Record<string, string> = { "User-Agent": APIuserAgent, "Referer": embedUrl };
        if (ytcookies || tempytcookies) headers.Cookie = ytcookies || tempytcookies;
        const html = await (await fetch(`https://${hostdomain}/embed/${videoId}?html5=1`, { headers })).text();
        const m = html.match(/ytcfg\.set\(\{([\s\S]*?)\}\)\s*;/);
        const ytcfg = m ? JSON.parse("{" + m[1] + "}") : null;
        embeddedContext = {
            thirdParty: ytcfg?.INNERTUBE_CONTEXT?.thirdParty || null,
            encryptedHostFlags: ytcfg?.WEB_PLAYER_CONTEXT_CONFIGS?.WEB_PLAYER_CONTEXT_CONFIG_ID_EMBEDDED_PLAYER?.encryptedHostFlags || null
        };
        Logger.info(`/ [YoutubeConfig] Fetched Web Embedded Config`);
    } catch (e) {
        console.error(e);
    }
    return embeddedContext;
}

type Mode = "anon" | "auth";

// youtubei.js builds the requests; this rewrites only the /player call so it
// goes out as the configured client, with its host, headers and auth.
function createFetch(mode: Mode): typeof fetch {
    return async (input: any, init?: any) => {
        const request: Request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);

        if (url.hostname.endsWith("googlevideo.com")) {
            const headers = new Headers(init?.headers ?? request.headers);
            headers.set("User-Agent", APIuserAgent);
            return fetch(request, { ...init, headers });
        }
        if (!url.pathname.endsWith("/youtubei/v1/player")) return fetch(input, init);

        const body = JSON.parse(typeof init?.body === "string" ? init.body : await request.text());
        const originalClient = body.context?.client || {};
        body.context = {
            ...body.context,
            client: {
                ...playerClient,
                visitorData: originalClient.visitorData,
                ...(isWebClient && originalClient.configInfo ? { configInfo: originalClient.configInfo } : {}),
                ...(isEmbeddedClient ? { originalUrl: `https://${hostdomain}/embed/${body.videoId}?html5=1` } : {})
            }
        };
        if (isEmbeddedClient) {
            body.context.thirdParty = embeddedContext?.thirdParty ? { ...embeddedContext.thirdParty, embedUrl } : { embedUrl };
            if (embeddedContext?.encryptedHostFlags) {
                body.playbackContext ??= {};
                body.playbackContext.contentPlaybackContext = { ...body.playbackContext.contentPlaybackContext, encryptedHostFlags: embeddedContext.encryptedHostFlags };
            }
        }
        body.attestationRequest = { omitBotguardData: false };

        const headers: Record<string, string> = {
            "Accept-Language": "en",
            "Content-Type": "application/json",
            "X-Goog-Visitor-Id": originalClient.visitorData || "",
            "Origin": `https://${hostdomain}`,
            "X-Origin": `https://${hostdomain}`,
            "X-Youtube-Client-Name": String(useClient.clientName),
            "X-Youtube-Client-Version": useClient.clientVersion,
            "User-Agent": APIuserAgent
        };
        if (mode === "auth" && isVRAuth()) {
            headers.Authorization = "Bearer " + ytauth.token;
            if (tempytcookies) headers.Cookie = tempytcookies;
        } else if (mode === "auth" && ytcookies && isWebClient) {
            Object.assign(headers, {
                "Authorization": sapisidHash(),
                "Cookie": ytcookies,
                "X-Youtube-Bootstrap-Logged-In": "true",
                "Alt-Used": hostdomain,
                "X-Goog-AuthUser": "0"
            });
        } else if (tempytcookies) {
            headers.Cookie = tempytcookies;
        }

        url.hostname = hostdomain;
        return fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    };
}

const sessions: Partial<Record<Mode, Promise<Innertube>>> = {};

function getSession(mode: Mode): Promise<Innertube> {
    sessions[mode] ??= Innertube.create({
        fetch: createFetch(mode),
        // Only web clients need the JS player (signature timestamp, n/sig decipher,
        // `pot` on stream URLs). Non-web client URLs are played as returned.
        retrieve_player: isWebClient,
        generate_session_locally: false,
        user_agent: default_userAgent_desktop
    }).then((yt) => {
        Logger.info(`/ [YoutubeConfig] Created youtubei.js session (${mode})`);
        return yt;
    }).catch((e) => {
        delete sessions[mode];
        throw e;
    });
    return sessions[mode];
}

function resetSession(mode: Mode) {
    delete sessions[mode];
}

setAttestationSource(async () => (await getSession("anon")).getAttestationChallenge("ENGAGEMENT_TYPE_UNBOUND"));

async function warmup() {
    try {
        await fetchSwData();
        const yt = await getSession("anon");
        if (isWebClient) await initBotGuard();
        if (isEmbeddedClient) await fetchEmbeddedContext("dQw4w9WgXcQ");
        Logger.info(`/ [YoutubeConfig] Ready (${targetClient}, player ${yt.session.player?.player_id ?? "none"})`);
    } catch (e: any) {
        console.error(`[YoutubeConfig] Warmup failed:`, e?.message || e);
    }
}
warmup();

function cachedTrack(videoId: string): fs.ReadStream | null {
    if (!cacheTrackYT) return null;
    for (const ext of ["webm", "m4a"]) {
        const file = path.join(cacheDir, `${videoId}.${ext}`);
        if (fs.existsSync(file)) return fs.createReadStream(file);
    }
    return null;
}

function cacheWhileStreaming(source: Readable, videoId: string, ext: string): Readable {
    if (!cacheTrackYT) return source;
    const out = new PassThrough();
    const tempFile = path.join(cacheDir, `${videoId}.${Date.now()}.temp`);
    const writer = fs.createWriteStream(tempFile);
    let failed = false;
    writer.on("error", (err) => {
        failed = true;
        console.error("Cache Write Error:", err);
    });
    source.on("data", (chunk) => {
        out.write(chunk);
        if (!failed) writer.write(chunk);
    });
    source.on("end", () => {
        out.end();
        writer.end(() => {
            if (failed) fs.unlink(tempFile, () => { });
            else fs.rename(tempFile, path.join(cacheDir, `${videoId}.${ext}`), (err) => { if (err) console.error("Cache rename failed:", err); });
        });
    });
    const abort = (err?: Error) => {
        writer.end(() => fs.unlink(tempFile, () => { }));
        out.destroy(err);
    };
    source.on("error", abort);
    out.on("close", () => { if (!source.readableEnded) source.destroy(); });
    return out;
}

async function streamWithMode(mode: Mode, videoId: string): Promise<Readable | string> {
    const yt = await getSession(mode);
    const visitorData = yt.session.context.client.visitorData;

    // Fresh PoTokens every request: content-bound (videoId) for the player
    // request, session-bound (dataSyncId when signed in, else visitorData)
    // for the stream URL `pot`.
    let contentPot: string;
    if (isWebClient) {
        if (isEmbeddedClient) await fetchEmbeddedContext(videoId);
        const sessionBinding = mode === "auth" && ytcookies && datasyncID ? datasyncID : visitorData;
        const [content, session] = await Promise.all([mintPoToken(videoId), mintPoToken(sessionBinding)]);
        contentPot = content.token;
        if (yt.session.player) yt.session.player.po_token = session.isReal ? session.token : undefined;
    } else {
        contentPot = await generateAnonPOT();
    }

    const info = await yt.getBasicInfo(videoId, { po_token: contentPot });
    const status = info.playability_status?.status;
    if (status !== "OK") {
        const err: any = new Error(`InnerTube Error: ${JSON.stringify(info.playability_status) || null}`);
        err.playability = status;
        throw err;
    }

    const hls = info.streaming_data?.hls_manifest_url;
    if (hls && (info.basic_info.is_live || streamTypeYT === 2)) return hls;
    if (!info.streaming_data?.adaptive_formats?.length && info.streaming_data?.server_abr_streaming_url) {
        throw new Error(`This content unavailable due youtube enforce SABR-only`);
    }

    const opts = { type: "audio" as const, quality: "best", format: "any" };
    const format = info.chooseFormat(opts);
    const ext = format.mime_type?.includes("webm") ? "webm" : "m4a";
    const stream = Readable.fromWeb((await info.download(opts)) as any);
    return cacheWhileStreaming(stream, videoId, ext);
}

async function fallbackYTStream(track: string): Promise<Readable | string> {
    refreshYtAuth();
    const videoId = track.includes("watch?v=") ? track.split("watch?v=")[1].split("&")[0] : track;

    const cached = cachedTrack(videoId);
    if (cached) return cached;

    const hasAuth = isVRAuth() || !!ytcookies;
    const mustUseAuth = forceAuthClients.includes(targetClient);
    const clientSupportsAuth = mustUseAuth || isWebClient || isVRAuth();
    let modes: Mode[] = mustUseAuth ? ["auth"] : (!hasAuth || !clientSupportsAuth ? ["anon"] : ["anon", "auth"]);
    if (modes.length > 1 && Date.now() < authRequiredUntil) modes = ["auth", "anon"];

    let lastError: any = null;
    for (const mode of modes) {
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                return await streamWithMode(mode, videoId);
            } catch (e: any) {
                lastError = e;
                Logger.info(`/ [YoutubeConfig] ${mode} attempt ${attempt + 1} failed: ${e?.message || e}`);
                if (e?.playability === "LOGIN_REQUIRED" && modes.includes("auth")) {
                    authRequiredUntil = Date.now() + 3600000;
                    break;
                }
                // Stale BotGuard program / session: re-attest and rebuild the session once.
                if (isWebClient) invalidateBotGuard();
                embeddedContext = null;
                resetSession(mode);
                await fetchSwData();
            }
        }
    }
    console.error(lastError);
    throw lastError;
}

export default {
    get cookie() { return ytcookiesapi; },
    disablePlayer: true,
    createStream: useNativeStream ? {} : async (q: { url: string }) => {
        try {
            return await fallbackYTStream(q.url);
        } catch {
            return undefined;
        }
    }
};
