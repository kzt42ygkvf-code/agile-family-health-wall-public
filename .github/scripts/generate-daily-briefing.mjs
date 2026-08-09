// scripts/generate-daily-briefing.ts
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// app/daily-briefing-contract.ts
var HAINAN_CITY_KEYS = Object.freeze([
  "lingshui",
  "haikou",
  "sanya",
  "wanning",
  "qionghai"
]);
var ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
var ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
var HAINAN_UTC_OFFSET_MS = 8 * 60 * 60 * 1e3;
var DAY_MS = 24 * 60 * 60 * 1e3;
var NEWS_ERROR_MESSAGE = "\u65B0\u95FB\u6682\u65F6\u65E0\u6CD5\u66F4\u65B0";
var WEATHER_ERROR_MESSAGE = "\u5929\u6C14\u6682\u65F6\u65E0\u6CD5\u66F4\u65B0";
var NEWS_ATTRIBUTION = Object.freeze({
  name: "\u4E2D\u56FD\u65B0\u95FB\u7F51",
  url: "https://www.chinanews.com.cn/",
  usage: "\u6807\u9898\u4E0E\u539F\u6587\u5165\u53E3\uFF1B\u6B63\u5F0F\u5546\u7528\u524D\u9700\u53D6\u5F97\u5185\u5BB9\u6388\u6743"
});
var MET_ATTRIBUTION = Object.freeze({
  name: "MET Norway",
  url: "https://api.met.no/",
  license: "CC BY 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/"
});
var CITY_NAMES = Object.freeze({
  lingshui: "\u9675\u6C34",
  haikou: "\u6D77\u53E3",
  sanya: "\u4E09\u4E9A",
  wanning: "\u4E07\u5B81",
  qionghai: "\u743C\u6D77"
});
function parseDailyBriefing(input) {
  const root = requireRecord(input);
  if (root.schemaVersion !== 1) fail();
  return {
    schemaVersion: 1,
    updatedAt: requireIsoTimestamp(root.updatedAt),
    news: parseNewsBranch(root.news),
    weather: parseWeatherBranch(root.weather)
  };
}
function parseNewsBranch(value) {
  const branch = requireRecord(value);
  if (branch.status === "error") {
    return { status: "error", message: requireExactText(branch.message, NEWS_ERROR_MESSAGE) };
  }
  if (branch.status !== "ok") fail();
  const items = requireArray(branch.items);
  if (items.length > 8) fail();
  return {
    status: "ok",
    updatedAt: requireIsoTimestamp(branch.updatedAt),
    source: parseNewsSource(branch.source),
    items: items.map(parseNewsItem)
  };
}
function parseNewsSource(value) {
  const source = requireRecord(value);
  return {
    name: requireExactText(source.name, NEWS_ATTRIBUTION.name),
    url: requireExactHttpsUrl(source.url, NEWS_ATTRIBUTION.url),
    usage: requireExactText(source.usage, NEWS_ATTRIBUTION.usage)
  };
}
function parseNewsItem(value) {
  const item = requireRecord(value);
  const url = requireChinaNewsUrl(item.url);
  return {
    id: requireExactText(item.id, url),
    title: requireText(item.title),
    publishedAt: requireIsoTimestamp(item.publishedAt),
    url
  };
}
function parseWeatherBranch(value) {
  const branch = requireRecord(value);
  if (branch.status === "error") {
    return { status: "error", message: requireExactText(branch.message, WEATHER_ERROR_MESSAGE) };
  }
  if (branch.status !== "ok") fail();
  const cities = requireRecord(branch.cities);
  const inputKeys = Object.keys(cities);
  if (inputKeys.length !== HAINAN_CITY_KEYS.length || !HAINAN_CITY_KEYS.every((key) => Object.hasOwn(cities, key))) {
    fail();
  }
  const parsedCities = {};
  for (const key of HAINAN_CITY_KEYS) {
    parsedCities[key] = parseWeatherCity(cities[key], CITY_NAMES[key]);
  }
  return {
    status: "ok",
    source: parseWeatherSource(branch.source),
    cities: parsedCities
  };
}
function parseWeatherSource(value) {
  const source = requireRecord(value);
  return {
    name: requireExactText(source.name, MET_ATTRIBUTION.name),
    url: requireExactHttpsUrl(source.url, MET_ATTRIBUTION.url),
    license: requireExactText(source.license, MET_ATTRIBUTION.license),
    licenseUrl: requireExactHttpsUrl(source.licenseUrl, MET_ATTRIBUTION.licenseUrl)
  };
}
function parseWeatherCity(value, expectedName) {
  const city = requireRecord(value);
  const daily = requireArray(city.daily);
  if (daily.length !== 4) fail();
  const updatedAt = requireIsoTimestamp(city.updatedAt);
  const parsedDaily = daily.map(parseWeatherDailyEntry);
  requireNextFourHainanDates(parsedDaily, updatedAt);
  return {
    name: requireExactText(city.name, expectedName),
    updatedAt,
    current: parseWeatherCurrent(city.current),
    daily: parsedDaily
  };
}
function requireNextFourHainanDates(entries, updatedAt) {
  const hainanDate = new Date(Date.parse(updatedAt) + HAINAN_UTC_OFFSET_MS).toISOString().slice(0, 10);
  const hainanMidnightUtc = Date.parse(`${hainanDate}T00:00:00.000Z`);
  for (let index = 0; index < entries.length; index += 1) {
    const expectedDate = new Date(hainanMidnightUtc + (index + 1) * DAY_MS).toISOString().slice(0, 10);
    if (entries[index].date !== expectedDate) fail();
  }
}
function parseWeatherCurrent(value) {
  const current = requireRecord(value);
  return {
    temperatureC: requireIntegerInRange(current.temperatureC, -80, 70),
    condition: requireText(current.condition),
    symbol: requireText(current.symbol),
    humidityPercent: requireIntegerInRange(current.humidityPercent, 0, 100),
    windKph: requireIntegerInRange(current.windKph, 0, 500)
  };
}
function parseWeatherDailyEntry(value) {
  const entry = requireRecord(value);
  const minC = requireIntegerInRange(entry.minC, -80, 70);
  const maxC = requireIntegerInRange(entry.maxC, -80, 70);
  if (minC > maxC) fail();
  return {
    date: requireIsoDate(entry.date),
    condition: requireText(entry.condition),
    symbol: requireText(entry.symbol),
    minC,
    maxC
  };
}
function requireRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail();
  return value;
}
function requireArray(value) {
  if (!Array.isArray(value)) fail();
  return value;
}
function requireText(value) {
  if (typeof value !== "string" || value.trim().length === 0) fail();
  return value;
}
function requireExactText(value, expected) {
  if (requireText(value) !== expected) fail();
  return expected;
}
function requireHttpsUrl(value) {
  const url = requireText(value);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname.length === 0) fail();
  } catch {
    fail();
  }
  return url;
}
function requireExactHttpsUrl(value, expected) {
  if (requireHttpsUrl(value) !== expected) fail();
  return expected;
}
function requireChinaNewsUrl(value) {
  const url = requireHttpsUrl(value);
  const parsed = new URL(url);
  if (parsed.hostname !== "www.chinanews.com.cn" || parsed.username !== "" || parsed.password !== "" || parsed.port !== "") {
    fail();
  }
  return url;
}
function requireIsoTimestamp(value) {
  const timestamp = requireText(value);
  if (!ISO_TIMESTAMP.test(timestamp) || !isCalendarDate(timestamp.slice(0, 10)) || Number.isNaN(Date.parse(timestamp))) fail();
  return timestamp;
}
function requireIsoDate(value) {
  const date = requireText(value);
  if (!ISO_DATE.test(date) || !isCalendarDate(date)) fail();
  return date;
}
function isCalendarDate(value) {
  const parsed = /* @__PURE__ */ new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function requireIntegerInRange(value, minimum, maximum) {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < minimum || value > maximum) {
    fail();
  }
  return value;
}
function fail() {
  throw new TypeError("\u4ECA\u65E5\u8D44\u8BAF\u6570\u636E\u65E0\u6548");
}

// worker/daily-briefing.ts
var NEWS_URL = "https://www.chinanews.com.cn/rss/scroll-news.xml";
var MET_URL = "https://api.met.no/weatherapi/locationforecast/2.0/compact";
var USER_AGENT = "HopeFamilyHealthWall/1.3 https://hope-m.com";
var UPSTREAM_MAX_BYTES = 256 * 1024;
var BRIEFING_MAX_BYTES = 128 * 1024;
var NEWS_ERROR = { status: "error", message: "\u65B0\u95FB\u6682\u65F6\u65E0\u6CD5\u66F4\u65B0" };
var WEATHER_ERROR = { status: "error", message: "\u5929\u6C14\u6682\u65F6\u65E0\u6CD5\u66F4\u65B0" };
var CITY_NAMES2 = {
  lingshui: "\u9675\u6C34",
  haikou: "\u6D77\u53E3",
  sanya: "\u4E09\u4E9A",
  wanning: "\u4E07\u5B81",
  qionghai: "\u743C\u6D77"
};
var CITY_COORDINATES = {
  lingshui: { lat: "18.5060", lon: "110.0380" },
  haikou: { lat: "20.0440", lon: "110.1999" },
  sanya: { lat: "18.2528", lon: "109.5119" },
  wanning: { lat: "18.7951", lon: "110.3897" },
  qionghai: { lat: "19.2592", lon: "110.4746" }
};
var HAINAN_DATE_FORMATTER = new Intl.DateTimeFormat("en", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});
async function buildDailyBriefing(fetcher = fetch, logger) {
  const [news, weather] = await Promise.all([
    loadNews(fetcher).then(validateNewsBranch).catch((error) => {
      logBranchFailure(logger, "news", error);
      return NEWS_ERROR;
    }),
    loadAllWeather(fetcher).then(validateWeatherBranch).catch((error) => {
      logBranchFailure(logger, "weather", error);
      return WEATHER_ERROR;
    })
  ]);
  return fitBriefingWithinLimit(news, weather);
}
function logBranchFailure(logger, branch, error) {
  if (!logger) return;
  const fallback = "upstream processing failed";
  const rawMessage = error instanceof Error ? error.message : fallback;
  const message = isSafeErrorMessage(rawMessage) ? rawMessage : fallback;
  logger.error("[daily-briefing] branch failed", {
    branch,
    error: { name: error instanceof TypeError ? "TypeError" : "Error", message }
  });
}
function isSafeErrorMessage(message) {
  return /^(?:upstream (?:fetch failed|timeout|content-type rejected|redirect rejected|body too large|body invalid|JSON invalid)|upstream HTTP status \d{3}|news unavailable|weather unavailable|invalid RSS|今日资讯数据无效)$/.test(message);
}
function parseBranches(news, weather) {
  return parseDailyBriefing({
    schemaVersion: 1,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    news,
    weather
  });
}
function validateNewsBranch(news) {
  return parseBranches(news, WEATHER_ERROR).news;
}
function validateWeatherBranch(weather) {
  return parseBranches(NEWS_ERROR, weather).weather;
}
function fitBriefingWithinLimit(news, weather) {
  const full = parseBranches(news, weather);
  if (jsonByteLength(full) <= BRIEFING_MAX_BYTES) return briefingResult(full);
  const candidates = [
    weather.status === "ok" ? parseBranches(NEWS_ERROR, weather) : null,
    news.status === "ok" ? parseBranches(news, WEATHER_ERROR) : null
  ].filter((body) => body !== null && jsonByteLength(body) <= BRIEFING_MAX_BYTES);
  if (candidates.length > 0) {
    candidates.sort((left, right) => jsonByteLength(right) - jsonByteLength(left));
    return briefingResult(candidates[0]);
  }
  return briefingResult(parseBranches(NEWS_ERROR, WEATHER_ERROR));
}
function briefingResult(body) {
  return {
    body,
    status: body.news.status === "error" && body.weather.status === "error" ? 502 : 200
  };
}
function jsonByteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
async function loadNews(fetcher) {
  const xml = await fetchUpstream(fetcher, NEWS_URL, ["application/rss+xml", "application/xml", "text/xml"]);
  const items = parseRssItems(xml);
  if (items.length === 0) throw new Error("news unavailable");
  const updatedAt = items[0].publishedAt;
  return {
    status: "ok",
    updatedAt,
    source: {
      name: "\u4E2D\u56FD\u65B0\u95FB\u7F51",
      url: "https://www.chinanews.com.cn/",
      usage: "\u6807\u9898\u4E0E\u539F\u6587\u5165\u53E3\uFF1B\u6B63\u5F0F\u5546\u7528\u524D\u9700\u53D6\u5F97\u5185\u5BB9\u6388\u6743"
    },
    items
  };
}
async function loadAllWeather(fetcher) {
  const entries = await Promise.all(
    HAINAN_CITY_KEYS.map(async (key) => [key, await loadWeatherCity(fetcher, key)])
  );
  return {
    status: "ok",
    source: {
      name: "MET Norway",
      url: "https://api.met.no/",
      license: "CC BY 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/"
    },
    cities: Object.fromEntries(entries)
  };
}
async function loadWeatherCity(fetcher, key) {
  const url = new URL(MET_URL);
  url.searchParams.set("lat", CITY_COORDINATES[key].lat);
  url.searchParams.set("lon", CITY_COORDINATES[key].lon);
  const json = await fetchUpstream(fetcher, url, ["application/json"]);
  let forecast;
  try {
    forecast = JSON.parse(json);
  } catch {
    throw new Error("upstream JSON invalid");
  }
  return normalizeMetForecast(key, forecast);
}
async function fetchUpstream(fetcher, url, acceptedContentTypes) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6e3);
  try {
    let response;
    try {
      response = await fetcher(url, {
        headers: { "User-Agent": USER_AGENT },
        redirect: "error",
        signal: controller.signal
      });
    } catch {
      throw new Error(controller.signal.aborted ? "upstream timeout" : "upstream fetch failed");
    }
    if (!response.ok) throw new Error(`upstream HTTP status ${response.status}`);
    if (response.redirected) throw new Error("upstream redirect rejected");
    const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (!contentType || !acceptedContentTypes.includes(contentType)) {
      throw new Error("upstream content-type rejected");
    }
    try {
      return await readBoundedText(response);
    } catch (error) {
      if (controller.signal.aborted) throw new Error("upstream timeout", { cause: error });
      if (error instanceof Error && error.message === "upstream body too large") throw error;
      throw new Error("upstream body invalid", { cause: error });
    }
  } finally {
    clearTimeout(timeoutId);
  }
}
async function readBoundedText(response) {
  const declaredLength = response.headers.get("Content-Length");
  if (declaredLength !== null) {
    const bytes = Number(declaredLength);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > UPSTREAM_MAX_BYTES) {
      throw new Error("upstream body too large");
    }
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > UPSTREAM_MAX_BYTES) {
      await reader.cancel();
      throw new Error("upstream body too large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body);
}
function normalizeMetForecast(key, forecast) {
  const chronologicalEntries = [...forecast.properties.timeseries].sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
  const first = chronologicalEntries[0];
  if (!first) throw new Error("weather unavailable");
  const currentDate = hainanLocalDate(first.time);
  const dailyGroups = /* @__PURE__ */ new Map();
  for (const entry of chronologicalEntries) {
    const date = hainanLocalDate(entry.time);
    dailyGroups.set(date, [...dailyGroups.get(date) ?? [], entry]);
  }
  const futureGroups = [...dailyGroups].filter(([date]) => date !== currentDate);
  if (futureGroups.length < 4) throw new Error("weather unavailable");
  const daily = futureGroups.slice(0, 4).map(([date, entries]) => {
    const temperatures = entries.flatMap((entry) => {
      const periodDetails = [entry.data.next_6_hours?.details, entry.data.next_12_hours?.details];
      return [
        entry.data.instant.details.air_temperature,
        ...periodDetails.flatMap((details) => [
          ...typeof details?.air_temperature_min === "number" ? [details.air_temperature_min] : [],
          ...typeof details?.air_temperature_max === "number" ? [details.air_temperature_max] : []
        ])
      ];
    });
    const symbol2 = entries[0] ? metSymbol(entries[0]) : "unknown";
    return {
      date,
      condition: describeMetSymbol(symbol2),
      symbol: symbol2,
      minC: Math.round(Math.min(...temperatures)),
      maxC: Math.round(Math.max(...temperatures))
    };
  });
  const symbol = metSymbol(first);
  return {
    name: CITY_NAMES2[key],
    updatedAt: forecast.properties.meta.updated_at,
    current: {
      temperatureC: Math.round(first.data.instant.details.air_temperature),
      condition: describeMetSymbol(symbol),
      symbol,
      humidityPercent: Math.round(first.data.instant.details.relative_humidity),
      windKph: Math.round(first.data.instant.details.wind_speed * 3.6)
    },
    daily
  };
}
function metSymbol(entry) {
  return entry.data.next_1_hours?.summary?.symbol_code ?? entry.data.next_6_hours?.summary?.symbol_code ?? entry.data.next_12_hours?.summary?.symbol_code ?? "unknown";
}
function describeMetSymbol(symbol) {
  const base = symbol.toLowerCase().replace(/_(?:day|night|polartwilight)$/, "");
  if (base.includes("thunder")) return "\u96F7\u9635\u96E8";
  if (base === "clearsky") return "\u6674";
  if (base === "fair") return "\u6674\u95F4\u591A\u4E91";
  if (base === "partlycloudy") return "\u591A\u4E91";
  if (base === "cloudy") return "\u9634";
  if (base === "fog") return "\u96FE";
  if (base.startsWith("heavyrainshowers")) return "\u5F3A\u9635\u96E8";
  if (base.startsWith("lightrainshowers")) return "\u5C0F\u9635\u96E8";
  if (base.startsWith("rainshowers")) return "\u9635\u96E8";
  if (base.startsWith("heavyrain")) return "\u5927\u96E8";
  if (base.startsWith("lightrain")) return "\u5C0F\u96E8";
  if (base.startsWith("rain")) return "\u4E2D\u96E8";
  if (base.includes("sleet")) return "\u96E8\u5939\u96EA";
  if (base.startsWith("heavysnowshowers")) return "\u5F3A\u9635\u96EA";
  if (base.startsWith("lightsnowshowers")) return "\u5C0F\u9635\u96EA";
  if (base.startsWith("snowshowers")) return "\u9635\u96EA";
  if (base.startsWith("heavysnow")) return "\u5927\u96EA";
  if (base.startsWith("lightsnow")) return "\u5C0F\u96EA";
  if (base.startsWith("snow")) return "\u4E2D\u96EA";
  return "\u5929\u6C14\u53D8\u5316";
}
function hainanLocalDate(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) throw new Error("weather unavailable");
  const parts = Object.fromEntries(
    HAINAN_DATE_FORMATTER.formatToParts(date).filter((part) => part.type === "year" || part.type === "month" || part.type === "day").map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function parseRssItems(xml) {
  return [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].flatMap((match) => {
    try {
      const item = match[1];
      const title = xmlPlainText(tagText(item, "title"));
      const url = xmlPlainText(tagText(item, "link"));
      const published = new Date(xmlPlainText(tagText(item, "pubDate")));
      const parsedUrl = new URL(url);
      if (title.length === 0 || Number.isNaN(published.getTime()) || parsedUrl.protocol !== "https:" || parsedUrl.hostname !== "www.chinanews.com.cn" || parsedUrl.username !== "" || parsedUrl.password !== "") {
        return [];
      }
      return [{ id: parsedUrl.href, title, publishedAt: published.toISOString(), url: parsedUrl.href }];
    } catch {
      return [];
    }
  }).sort((left, right) => right.publishedAt.localeCompare(left.publishedAt)).slice(0, 8);
}
function tagText(xml, tag) {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(xml);
  if (!match) throw new Error("invalid RSS");
  return match[1].trim();
}
function xmlPlainText(value) {
  const withoutCdata = value.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/i, "$1");
  const decoded = withoutCdata.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code) => {
    const normalized = code.toLowerCase();
    if (normalized === "amp") return "&";
    if (normalized === "lt") return "<";
    if (normalized === "gt") return ">";
    if (normalized === "quot") return '"';
    if (normalized === "apos") return "'";
    const point = normalized.startsWith("#x") ? Number.parseInt(normalized.slice(2), 16) : Number.parseInt(normalized.slice(1), 10);
    return Number.isSafeInteger(point) && point >= 0 && point <= 1114111 ? String.fromCodePoint(point) : "";
  });
  return decoded.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

// scripts/generate-daily-briefing.ts
async function generateDailyBriefing(outputPath, builder = buildDailyBriefing) {
  const result = await builder();
  if (result.status !== 200) {
    throw new Error(`Daily briefing build returned ${result.status}; previous file was preserved`);
  }
  const body = parseDailyBriefing(result.body);
  const absoluteOutputPath = path.resolve(outputPath);
  const outputDirectory = path.dirname(absoluteOutputPath);
  const temporaryPath = path.join(
    outputDirectory,
    `.${path.basename(absoluteOutputPath)}.${process.pid}.${randomUUID()}.tmp`
  );
  await mkdir(outputDirectory, { recursive: true });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(body)}
`, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, absoluteOutputPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
async function testFixtureBuilder(fixturePath) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("DAILY_BRIEFING_TEST_FIXTURE is only available when NODE_ENV=test");
  }
  const body = parseDailyBriefing(JSON.parse(await readFile(fixturePath, "utf8")));
  return { status: 200, body };
}
async function main() {
  const outputPath = process.argv[2];
  if (!outputPath) throw new Error("Usage: generate-daily-briefing <output-path>");
  const fixturePath = process.env.DAILY_BRIEFING_TEST_FIXTURE;
  const builder = fixturePath ? () => testFixtureBuilder(fixturePath) : buildDailyBriefing;
  await generateDailyBriefing(outputPath, builder);
}
var entryPath = process.argv[1];
if (entryPath && pathToFileURL(path.resolve(entryPath)).href === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "Daily briefing generation failed";
    process.stderr.write(`${message}
`);
    process.exitCode = 1;
  });
}
export {
  generateDailyBriefing
};
