// 天气查询：Open-Meteo（免费、无需 Key），失败时返回提示让 Agent 改用联网搜索

const WMO_CODES: Record<number, string> = {
  0: '晴',
  1: '晴间多云',
  2: '多云',
  3: '阴',
  45: '雾',
  48: '冻雾',
  51: '毛毛雨',
  53: '毛毛雨',
  55: '毛毛雨',
  56: '冻毛毛雨',
  57: '冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '阵雨',
  81: '阵雨',
  82: '强阵雨',
  85: '阵雪',
  86: '阵雪',
  95: '雷阵雨',
  96: '雷阵雨伴冰雹',
  99: '雷阵雨伴冰雹',
};

const WIND_DIRS = ['北风', '东北风', '东风', '东南风', '南风', '西南风', '西风', '西北风'];

interface GeoResult {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  admin1?: string;
}

function windDir(deg: number): string {
  const i = Math.round(((deg % 360) / 45)) % 8;
  return WIND_DIRS[i];
}

function weatherText(code: number): string {
  return WMO_CODES[code] ?? '天气未知';
}

/** 用 Open-Meteo 地理编码把中文城市名转成经纬度 */
async function geoCode(city: string): Promise<GeoResult | null> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36' },
  });
  if (!resp.ok) return null;
  const data = (await resp.json()) as {
    results?: Array<{ name: string; latitude: number; longitude: number; country?: string; admin1?: string }>;
  };
  const r = data.results?.[0];
  return r
    ? { name: r.name, latitude: r.latitude, longitude: r.longitude, country: r.country, admin1: r.admin1 }
    : null;
}

/** 查询某城市未来两天的天气，返回给 Agent 的中文文本 */
export async function getWeather(cityRaw: string, whenRaw?: string): Promise<string> {
  const city = String(cityRaw ?? '').trim();
  const when = String(whenRaw ?? '').trim();
  if (!city) return '请告诉我城市名，例如：北京、上海、广州';

  let geo: GeoResult | null = null;
  try {
    geo = await geoCode(city);
  } catch (err) {
    return `天气服务暂时无法访问（${err instanceof Error ? err.message : String(err)}），建议改用网页搜索查询天气`;
  }
  if (!geo) {
    return `找不到城市“${city}”，可以试试带上省/市全称，例如“广州市”“西安市”`;
  }

  try {
    const params = new URLSearchParams({
      latitude: String(geo.latitude),
      longitude: String(geo.longitude),
      current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,wind_direction_10m_dominant',
      timezone: 'auto',
      forecast_days: '2',
    });
    const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36' },
    });
    if (!resp.ok) return `天气服务请求失败（HTTP ${resp.status}），建议改用网页搜索查询天气`;
    const data = (await resp.json()) as {
      current?: {
        temperature_2m?: number;
        relative_humidity_2m?: number;
        apparent_temperature?: number;
        weather_code?: number;
        wind_speed_10m?: number;
        wind_direction_10m?: number;
      };
      daily?: {
        time?: string[];
        weather_code?: number[];
        temperature_2m_max?: number[];
        temperature_2m_min?: number[];
        precipitation_probability_max?: number[];
        wind_speed_10m_max?: number[];
        wind_direction_10m_dominant?: number[];
      };
    };

    const cur = data.current;
    const daily = data.daily;
    const lines: string[] = [];
    const region = [geo.country, geo.admin1, geo.name].filter(Boolean).join(' · ');
    lines.push(`城市：${region}`);

    if (cur && typeof cur.temperature_2m === 'number') {
      const feel = typeof cur.apparent_temperature === 'number' ? `，体感 ${Math.round(cur.apparent_temperature)}°C` : '';
      const wind = typeof cur.wind_direction_10m === 'number' ? windDir(cur.wind_direction_10m) : '';
      lines.push(
        `当前：${weatherText(cur.weather_code ?? -1)}，${Math.round(cur.temperature_2m)}°C${feel}，湿度 ${Math.round(
          cur.relative_humidity_2m ?? 0
        )}%，${wind} ${Math.round(cur.wind_speed_10m ?? 0)} km/h`
      );
    }

    if (daily && Array.isArray(daily.time)) {
      daily.time.forEach((d, i) => {
        const max = daily.temperature_2m_max?.[i];
        const min = daily.temperature_2m_min?.[i];
        const rain = daily.precipitation_probability_max?.[i];
        const wind = daily.wind_speed_10m_max?.[i];
        const dir = daily.wind_direction_10m_dominant?.[i];
        const label = i === 0 ? '今天' : '明天';
        const temp = typeof max === 'number' && typeof min === 'number' ? `${Math.round(min)}~${Math.round(max)}°C` : '';
        const rainTxt = typeof rain === 'number' ? `，降水概率 ${Math.round(rain)}%` : '';
        const windTxt = typeof wind === 'number' ? `，${typeof dir === 'number' ? windDir(dir) : ''} ${Math.round(wind)} km/h` : '';
        lines.push(`${label}（${d}）：${weatherText(daily.weather_code?.[i] ?? -1)}，${temp}${rainTxt}${windTxt}`);
      });
    }

    if (when.includes('明天')) {
      lines.splice(2, 1); // 只保留明天的逐日详情
      return lines.join('\n');
    }
    return lines.join('\n');
  } catch (err) {
    return `天气服务暂时无法访问（${err instanceof Error ? err.message : String(err)}），建议改用网页搜索查询天气`;
  }
}
