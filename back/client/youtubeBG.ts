import { Logger } from "@tryforge/forgescript";
import { JSDOM } from "jsdom";
import config from "../config.json";

const { default_userAgent_desktop } = config;

const YTBG_KEY = "AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw";
const POTOKEN_REQUEST_KEY = "O43z0dpjhgX20SCx4KAo";
const INTEGRITY_TTL_FALLBACK = 30 * 60 * 1000;

export interface PoTokenResult {
    token: string;
    isReal: boolean;
}

interface BgChallenge {
    program: string;
    globalName: string;
    interpreterJs: string;
}

type AttestationSource = () => Promise<any>;

let bgModulesPromise: Promise<any> | null = null;
let bgModules: any = null;
function getBgModules(): Promise<any> {
    bgModulesPromise ??= Promise.all([
        import("bgutils-js/botguard"),
        import("bgutils-js/webpo"),
        import("bgutils-js/utils")
    ]).then(([botguard, webpo, utils]) => {
        bgModules = {
            getChallenge: botguard.getChallenge,
            BotGuardClient: botguard.BotGuardClient,
            WebPoMinter: webpo.WebPoMinter,
            createColdStartToken: webpo.createColdStartToken,
            parseLooseJSON: utils.parseLooseJSON
        };
        return bgModules;
    });
    return bgModulesPromise;
}

let attestationSource: AttestationSource | null = null;
export function setAttestationSource(source: AttestationSource) {
    attestationSource = source;
}

let bgDomInitialized = false;
function ensureBgDom(ytConfig?: any) {
    if (bgDomInitialized && !ytConfig) return;
    // jsdom v30 reads userAgent from `resources`, a top-level userAgent is ignored.
    const dom: any = new JSDOM('<!DOCTYPE html><html lang="en"><head><title></title></head><body></body></html>', {
        url: "https://www.youtube.com/",
        referrer: "https://www.youtube.com/",
        userAgent: default_userAgent_desktop
    } as any);
    if (ytConfig) dom.window.yt = { config_: ytConfig };
    Object.assign(globalThis, {
        ...(ytConfig ? { yt: dom.window.yt } : {}),
        window: dom.window,
        document: dom.window.document,
        location: dom.window.location,
        origin: dom.window.origin
    });
    if (!("navigator" in globalThis)) {
        Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator });
    }
    bgDomInitialized = true;
}

async function fetchInterpreter(url: string): Promise<string> {
    const res = await fetch(url.startsWith("//") ? `https:${url}` : url, { headers: { "user-agent": default_userAgent_desktop } });
    if (!res.ok) throw new Error(`interpreter fetch failed: ${res.status}`);
    const js = await res.text();
    if (!js) throw new Error("empty interpreter script");
    return js;
}

// Challenge source 1: InnerTube /att/get (YtAtt), fetched through youtubei.js.
async function challengeFromAttestation(): Promise<BgChallenge> {
    if (!attestationSource) throw new Error("no attestation source registered");
    const res = await attestationSource();
    const bg = res?.bg_challenge;
    if (!bg?.program || !bg?.global_name) throw new Error("att/get returned no bgChallenge");
    const inline = bg.interpreter_url?.private_do_not_access_or_else_safe_script_wrapped_value;
    const url = bg.interpreter_url?.private_do_not_access_or_else_trusted_resource_url_wrapped_value;
    const interpreterJs = inline || (url ? await fetchInterpreter(url) : "");
    if (!interpreterJs) throw new Error("att/get interpreter missing");
    ensureBgDom();
    return { program: bg.program, globalName: bg.global_name, interpreterJs };
}

// Challenge source 2: page-embedded ytAtN.
async function challengeFromPage(): Promise<BgChallenge> {
    const { parseLooseJSON } = await getBgModules();
    const pageRes = await fetch("https://www.youtube.com/", {
        headers: { "accept": "*/*", "accept-language": "en-US", "user-agent": default_userAgent_desktop }
    });
    if (!pageRes.ok) throw new Error(`watch page fetch failed: ${pageRes.status}`);
    const pageHtml = await pageRes.text();
    const ytcfgMatch = pageHtml.match(/ytcfg\.set\(({.+?})\);/s);
    if (!ytcfgMatch) throw new Error("ytcfg not found in page HTML");
    let ytConfig;
    try {
        ytConfig = JSON.parse(ytcfgMatch[1]);
    } catch {
        throw new Error("ytcfg parse failed");
    }
    const atnMatch = pageHtml.match(/window\.ytAtN\(\s*({[\s\S]*?})\s*\)/);
    if (!atnMatch) throw new Error("ytAtN challenge not found in page HTML");
    const bg = parseLooseJSON(atnMatch[1])?.R?.bgChallenge;
    if (!bg?.program || !bg?.globalName) throw new Error("page bgChallenge incomplete");
    const url = bg.interpreterUrl?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
    if (!url) throw new Error("page interpreter URL missing");
    const interpreterJs = await fetchInterpreter(url);
    ensureBgDom(ytConfig);
    return { program: bg.program, globalName: bg.globalName, interpreterJs };
}

// Challenge source 3: WAA Create API.
async function challengeFromWaa(): Promise<BgChallenge> {
    ensureBgDom();
    const { getChallenge } = await getBgModules();
    const challenge = await getChallenge({ requestKey: POTOKEN_REQUEST_KEY, fetchFunction: fetch, useYouTubeAPI: true });
    const interpreterJs = challenge?.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
    if (!challenge || !interpreterJs) throw new Error("WAA challenge unavailable");
    return { program: challenge.program, globalName: challenge.globalName, interpreterJs };
}

const challengeSources: Array<[string, () => Promise<BgChallenge>]> = [
    ["att/get", challengeFromAttestation],
    ["page ytAtN", challengeFromPage],
    ["WAA Create", challengeFromWaa]
];

async function solveChallenge(): Promise<BgChallenge> {
    let lastError: any;
    for (const [label, source] of challengeSources) {
        try {
            const challenge = await source();
            new Function(challenge.interpreterJs)();
            Logger.info(`/ [YoutubeBG] BotGuard challenge source: ${label}`);
            return challenge;
        } catch (e: any) {
            lastError = e;
            Logger.info(`/ [YoutubeBG] ${label} challenge failed: ${e?.message || e}`);
        }
    }
    throw lastError;
}

// The integrity token and its minter must come from the same BotGuard snapshot,
// and each WebPoMinter.create() on the same signal output chains VM state and
// yields server-rejected pots, so one minter is kept per integrity token.
interface MintPair { minter: any; exp: number; }
let mintPair: MintPair | null = null;
let mintPairPromise: Promise<MintPair> | null = null;

async function attest(): Promise<MintPair> {
    const challenge = await solveChallenge();
    const { BotGuardClient, WebPoMinter } = await getBgModules();
    const botguard = await BotGuardClient.create({ program: challenge.program, globalName: challenge.globalName, globalObject: globalThis });
    const webPoSignalOutput: any[] = [];
    const botguardResponse = await botguard.snapshot({ webPoSignalOutput });
    const res = await fetch("https://jnn-pa.googleapis.com/$rpc/google.internal.waa.v1.Waa/GenerateIT", {
        method: "POST",
        headers: {
            "Content-Type": "application/json+protobuf",
            "x-goog-api-key": YTBG_KEY,
            "x-user-agent": "grpc-web-javascript/0.1",
            "user-agent": default_userAgent_desktop
        },
        body: JSON.stringify([POTOKEN_REQUEST_KEY, botguardResponse])
    });
    if (!res.ok) {
        const snippet = await res.text().catch(() => "");
        throw new Error(`GenerateIT failed: HTTP ${res.status} ${snippet.slice(0, 160)}`);
    }
    const [integrityToken, ttlSecs] = await res.json();
    if (typeof integrityToken !== "string" || !integrityToken) throw new Error("BotGuard integrity token unavailable");
    const minter = await WebPoMinter.create({ integrityToken }, webPoSignalOutput);
    return { minter, exp: Date.now() + (ttlSecs ? ttlSecs * 1000 : INTEGRITY_TTL_FALLBACK) };
}

const ATTEST_FAILURE_COOLDOWN = 30 * 1000;
let lastAttestFailure = 0;

async function ensureMintPair(): Promise<MintPair> {
    if (mintPair && mintPair.exp > Date.now()) return mintPair;
    if (Date.now() - lastAttestFailure < ATTEST_FAILURE_COOLDOWN) throw new Error("BotGuard attestation cooling down");
    mintPairPromise ??= attest()
        .then((pair) => (mintPair = pair))
        .catch((e) => {
            lastAttestFailure = Date.now();
            throw e;
        })
        .finally(() => { mintPairPromise = null; });
    return mintPairPromise;
}

export function invalidateBotGuard() {
    mintPair = null;
}

export async function initBotGuard() {
    await ensureMintPair();
    Logger.info(`/ [YoutubeBG] BotGuard initialized`);
}

export async function generateAnonPOT(id?: string): Promise<string> {
    const identifier = id || Math.random().toString(36).substring(2, 13);
    const { createColdStartToken } = await getBgModules();
    return createColdStartToken(identifier);
}

/**
 * Mints a fresh PoToken bound to `binding` on every call: a videoId for a
 * content-bound (player request) token, or visitorData / dataSyncId for a
 * session-bound (streaming `pot`) token.
 */
export async function mintPoToken(binding: string): Promise<PoTokenResult> {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const pair = await ensureMintPair();
            const token = await pair.minter.mintAsWebsafeString(binding);
            if (token) return { token, isReal: true };
        } catch (e: any) {
            Logger.info(`/ [YoutubeBG] PoToken mint failed (${e?.message || e})${attempt === 0 ? ", re-attesting" : ""}`);
        }
        invalidateBotGuard();
    }
    return { token: await generateAnonPOT(binding), isReal: false };
}
