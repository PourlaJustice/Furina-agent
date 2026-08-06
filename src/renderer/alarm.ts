// 芙宁娜闹钟弹窗逻辑
// - BGM：优先播放 resources/audio/reminder-bgm.mp3（用户放入的芙宁娜登场素材）
// - 兜底：WebAudio 合成“当当当”三连音（无素材也能响）
// - 语音：用 MiniMax TTS 自动朗读提醒内容

const params = new URLSearchParams(location.search);
const text = params.get("text") ?? "时间到啦！";
const dueAt = Number(params.get("dueAt") ?? Date.now());

document.getElementById("alarm-text")!.textContent = text;
document.getElementById("alarm-time")!.textContent =
  "设定时间 " + new Date(dueAt).toLocaleString("zh-CN", { hour12: false });

async function playBgm(): Promise<void> {
  try {
    const bgm = await window.electronAPI.alarm.getBgm();
    if (bgm?.base64) {
      const audio = document.getElementById("bgm") as HTMLAudioElement;
      audio.src = `data:${bgm.format ?? "audio/mpeg"};base64,${bgm.base64}`;
      audio.volume = 0.45;
      await audio.play().catch(() => {});
      return;
    }
  } catch {
    // 读取失败走兜底
  }
  playFallbackJingle();
}

/** 找不到素材时的“当当当”合成三连音（C5-E5-G5 上行钟声） */
function playFallbackJingle(): void {
  try {
    const ctx = new AudioContext();
    const notes = [523.25, 659.25, 783.99];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t = ctx.currentTime + i * 0.3;
      gain.gain.setValueAtTime(0.001, t);
      gain.gain.exponentialRampToValueAtTime(0.45, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.95);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 1.1);
    });
  } catch {
    // 无法合成音频时静默
  }
}

/** 用 MiniMax TTS 朗读提醒内容（未配置则跳过） */
async function speakReminder(): Promise<void> {
  try {
    const res = await window.electronAPI.tts.speak(text);
    if (res.audioBase64) {
      const a = new Audio("data:audio/mp3;base64," + res.audioBase64);
      await a.play().catch(() => {});
    }
  } catch {
    // 语音失败不阻塞闹钟
  }
}

document.getElementById("alarm-ok")!.addEventListener("click", () => {
  window.electronAPI.alarm.close();
});
document.getElementById("alarm-snooze")!.addEventListener("click", () => {
  window.electronAPI.alarm.snooze(text);
});

void playBgm();
void speakReminder();
