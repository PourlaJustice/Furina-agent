import * as PIXI from "pixi.js";
import { Live2DModel } from "pixi-live2d-display/cubism4";
import type { ConversationAction } from "./actions";

// 芙宁娜模型的动作列表（motions/ 目录）
// 待机动画含 Param128(0→900) 疑似导致无限放大，点击动作改用有面部动画的摊手
const MOTION_NAMES = ["摊手动画", "变芒", "变荒"] as const;
// 芙宁娜模型的表情列表（expressions/ 目录）
const EXPRESSION_NAMES = [
  "星星", "小脸红", "生气", "哭", "捂嘴", "托脸",
  "呆毛电风扇", "喝饮料", "拿蛋糕", "拿勺子", "猫猫嘴", "汗",
] as const;

function randomOf<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Live2D 管理器
 * 负责：创建 PixiJS 透明画布、加载 Cubism 模型、自适应缩放、
 *       点击/双击/拖拽交互、视线跟随、空闲动作、口型同步、表情切换
 */
export class Live2DManager {
  private app: PIXI.Application | null = null;
  private model: Live2DModel | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private lastTapAt = 0;
  private frameCount = 0;
  private blinkPhase: "wait" | "close" | "open" = "wait";
  private blinkStart = 0;
  private nextBlinkAt = 0;
  private chatMode = false;
  private speakingTimer: ReturnType<typeof setInterval> | null = null;
  private baseBounds: PIXI.Rectangle | null = null;
  /** 手势动画结束时间（期间暂停头部鼠标跟随，避免互相覆盖） */
  private gestureUntil = 0;

  /** 模型默认部件透明度（加载时快照，动作结束后恢复，避免残留隐藏/显示状态） */
  private defaultOpacities: number[] | null = null;
  /** 对话动作队列：串行播放，一次只做一个，避免动作叠加（“三只手”） */
  private actionQueue: ConversationAction[] = [];
  private actionPlaying = false;
  /** 等待动作完成的地方（动作队列） */
  private motionFinishWaiters: Array<() => void> = [];
  /** 动作队列代次：重新播放（朗读）时递增，强制中断旧队列 */
  private actionEpoch = 0;
  /** 动作播放完成时是否需要恢复默认姿态（部件透明度 + 中性表情 + 待机动画） */
  private resetOnMotionFinish = false;


  constructor(
    private canvas: HTMLCanvasElement,
    private width: number,
    private height: number,
  ) {}

  async init(modelPath: string): Promise<void> {
    this.app = new PIXI.Application({
      view: this.canvas,
      width: this.width,
      height: this.height,
      backgroundAlpha: 0, // ★ 透明背景
      antialias: true,
      resolution: window.devicePixelRatio || 1, // ★ 高 DPI 清晰度关键
      autoDensity: true, // ★ 让 canvas 逻辑尺寸与物理分辨率匹配
      powerPreference: "high-performance",
      autoStart: true,
    });

    // ★ 使用 cubism4 入口，需要 index.html 中引入 live2dcubismcore.min.js
    this.model = await Live2DModel.from(modelPath, {
      autoFocus: false, // 模型没有 HitAreas，先用自定义点击区域
      ticker: this.app.ticker, // ★ 关键：把 PIXI 时钟交给模型，否则动画更新循环不运行
    });
    this.app.stage.addChild(this.model);

    this.fixMaskCount();
    this.snapshotDefaultOpacities();
    this.baseBounds = this.model.getLocalBounds();
    this.fitToWindow(1.9); // 特写模式：脸部放大，接近面捕软件视角
    this.setupHitArea();
    this.setupInteractions();
    this.setupIdleMotions();
    this.dumpDrawables();
    this.startBlinking();
    this.startMouseTracking();

    // ★ 隐藏"牌子"部件（模型作者的水印牌，写着"仅供娱乐 禁止盈利"）
    try {
      const coreHide = (this.model as unknown as {
        internalModel?: {
          coreModel: {
            setPartOpacityById?: (id: string, v: number) => void;
            getPartOpacityById?: (id: string) => number;
            _model?: {
              drawables?: {
                opacities?: number[] | Uint8Array;
              };
            };
          };
          motionManager?: { stopAllMotions?: () => void };
        };
      })?.internalModel?.coreModel;
      if (coreHide?.setPartOpacityById) {
        coreHide.setPartOpacityById("Part187", 0);
        // ★ 直接设置牌子 3 个渲染层（ArtMesh1013/1014/1015）的底层透明度为 0
        // pixi-live2d-display 渲染读 drawables.opacities，part opacity 不生效
        const brandDrawables = [983, 984, 985];
        const opacities = coreHide._model?.drawables?.opacities;
        this.app?.ticker.add(() => {
          coreHide.setPartOpacityById?.("Part187", 0);
          if (opacities) {
            for (const idx of brandDrawables) {
              if (idx >= 0 && idx < opacities.length) opacities[idx] = 0;
            }
          }
          // 每 120 帧打印一次实际透明度
          if (this.frameCount++ % 120 === 0) {
            console.log(
              `[diag] Part187 opacity=${coreHide.getPartOpacityById?.("Part187")} drawable op=${opacities ? [983, 984, 985].map((i) => opacities[i]).join(",") : "n/a"}`
            );
          }
        });
        console.log(`[Furina] Part187 hidden, opacities array len=${opacities?.length}`);
      }
    } catch (err) {
      console.error("[Furina] Failed to hide Part187:", err);
    }

    console.log("[Furina] Live2D model loaded:", modelPath);

    // ★ 配置动作完成监听：一次性动作播完后恢复默认姿态（部件/表情/待机），
    // 并唤醒动作队列继续播放下一个动作
    try {
      const mm = (this.model as unknown as {
        internalModel?: {
          motionManager?: {
            groups?: { idle?: string };
            on?: (e: string, cb: () => void) => void;
          };
        };
      })?.internalModel?.motionManager;
      if (mm?.groups) mm.groups.idle = "Idle"; // 让库在动作完成后自动回到待机组
      mm?.on?.("motionFinish", () => {
        console.log("[Furina] motionFinish fired");
        const waiters = this.motionFinishWaiters.splice(0);
        for (const fn of waiters) fn();
        if (this.resetOnMotionFinish) {
          this.resetOnMotionFinish = false;
          this.restoreDefaultOpacities();
          this.resetExpressionNeutral();
          // 等库内部把动作优先级归零后再回待机，避免被拒绝
          setTimeout(() => this.resumeIdle(), 0);
        }
      });
    } catch {
      // 库版本差异时忽略，不影响主流程
    }

    // ★ 最后播放待机动画（必须在水印隐藏之后，否则会被 stopAllMotions 停掉）
    this.playMotion("待机动画");

    // 诊断：监听动画事件
    const modelAny = this.model as unknown as {
      on?: (e: string, cb: (...args: unknown[]) => void) => void;
      motion?: (name: string) => boolean;
    };
    modelAny.on?.("motionLoadError", (...args) => console.log("[diag] motionLoadError:", args));
    modelAny.on?.("motionLoaded", (...args) => console.log("[diag] motionLoaded:", args));
    modelAny.on?.("motionStart", (...args) => console.log("[diag] motionStart:", args));
    modelAny.on?.("motionFinish", (...args) => console.log("[diag] motionFinish:", args));
    setTimeout(() => {
      const played = modelAny.motion?.("待机动画");
      console.log("[diag] re-motion() returned:", played);
    }, 5000);
  }

  /**
   * ★ 修复遮罩渲染：模型有 84 个遮罩，超过单纹理 36/48 上限，
   * 导致脖子/阴影区域渲染错误（模糊一片）。
   * 把遮罩渲染纹理提升到 3 个（上限 32×3=96），遮罩即可完整渲染。
   */
  private fixMaskCount(): void {
    const internal = (this.model as unknown as {
      internalModel?: {
        renderer?: {
          _clippingManager?: {
            release?: () => void;
            initialize?: (
              model: unknown,
              drawableCount: number,
              drawableMasks: unknown,
              drawableMaskCounts: unknown,
              renderTextureCount: number
            ) => void;
            setClippingMaskBufferSize?: (size: number) => void;
          };
        };
        coreModel: {
          getDrawableCount?: () => number;
          getDrawableMasks?: () => unknown;
          getDrawableMaskCounts?: () => unknown;
        };
      };
    })?.internalModel;
    const renderer = internal?.renderer;
    const cm = renderer?._clippingManager;
    const core = internal?.coreModel;
    if (!cm?.initialize || !core?.getDrawableCount || !core.getDrawableMasks || !core.getDrawableMaskCounts) {
      console.warn("[Furina] mask fix unavailable");
      return;
    }
    try {
      cm.release?.();
      // 创建全新遮罩管理器（release 后旧实例内部数组已清空，不能复用）
      const ManagerCtor = (cm as unknown as { constructor: new () => unknown }).constructor;
      const newCm = new ManagerCtor() as {
        initialize: (
          model: unknown,
          drawableCount: number,
          drawableMasks: unknown,
          drawableMaskCounts: unknown,
          renderTextureCount: number
        ) => void;
        setClippingMaskBufferSize?: (size: number) => void;
      };
      newCm.setClippingMaskBufferSize?.(256);
      newCm.initialize(
        core,
        core.getDrawableCount(),
        core.getDrawableMasks(),
        core.getDrawableMaskCounts(),
        3 // 3 个渲染纹理 → 遮罩上限 96
      );
      (renderer as unknown as { _clippingManager: unknown })._clippingManager = newCm;
      console.log("[Furina] mask render textures -> 3 (96 mask limit)");
    } catch (err) {
      console.error("[Furina] mask fix failed:", err);
    }
  }

  /**
   * 鼠标跟随：眼珠和头部随鼠标位置转动（模拟面捕软件的镜头追踪）
   * 视频里的脸部生动感主要来自这里
   */
  private startMouseTracking(): void {
    const core = (this.model as unknown as {
      internalModel?: {
        coreModel: { setParameterValueById?: (id: string, v: number) => void };
      };
    })?.internalModel?.coreModel;
    if (!core?.setParameterValueById) return;

    let targetX = 0;
    let targetY = 0;
    let currentX = 0;
    let currentY = 0;

    // 鼠标在画布上的归一化位置（-1..1）
    this.canvas.addEventListener("pointermove", (e) => {
      const rect = this.canvas.getBoundingClientRect();
      targetX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      targetY = ((e.clientY - rect.top) / rect.height) * 2 - 1;
    });
    // 鼠标离开窗口时头部/眼珠平滑回正
    this.canvas.addEventListener("pointerleave", () => {
      targetX = 0;
      targetY = 0;
    });

    // 平滑跟随：每帧向目标值缓动
    this.app?.ticker.add(() => {
      currentX += (targetX - currentX) * 0.08;
      currentY += (targetY - currentY) * 0.08;
      // 幅度调小更自然：头 ±6/4 度，眼珠 ±0.35/0.2
      core.setParameterValueById?.("ParamEyeBallX", currentX * 0.35);
      core.setParameterValueById?.("ParamEyeBallY", currentY * 0.2);
      // 手势动画期间暂停头部跟随，避免参数互相覆盖
      if (performance.now() > this.gestureUntil) {
        core.setParameterValueById?.("ParamAngleX", currentX * 6);
        core.setParameterValueById?.("ParamAngleY", currentY * 4);
      }
    });
  }

  /**
   * 程序化眨眼：模型 EyeBlink 组为空且待机动画不含眼睛参数，
   * 手动周期性驱动 ParamEyeLOpen/ParamEyeROpen，让角色"活"起来
   */
  private startBlinking(): void {
    const core = (this.model as unknown as {
      internalModel?: { coreModel: { setParameterValueById?: (id: string, v: number) => void } };
    })?.internalModel?.coreModel;
    if (!core?.setParameterValueById) return;

    this.nextBlinkAt = performance.now() + 2000 + Math.random() * 2000;
    this.app?.ticker.add(() => {
      const now = performance.now();
      if (this.blinkPhase === "wait") {
        if (now >= this.nextBlinkAt) {
          this.blinkPhase = "close";
          this.blinkStart = now;
        }
      } else if (this.blinkPhase === "close") {
        // 150ms 闭眼
        const t = Math.min(1, (now - this.blinkStart) / 150);
        core.setParameterValueById?.("ParamEyeLOpen", 1 - t);
        core.setParameterValueById?.("ParamEyeROpen", 1 - t);
        if (t >= 1) {
          this.blinkPhase = "open";
          this.blinkStart = now;
        }
      } else if (this.blinkPhase === "open") {
        // 200ms 睁眼
        const t = Math.min(1, (now - this.blinkStart) / 200);
        core.setParameterValueById?.("ParamEyeLOpen", t);
        core.setParameterValueById?.("ParamEyeROpen", t);
        if (t >= 1) {
          this.blinkPhase = "wait";
          this.nextBlinkAt = now + 2500 + Math.random() * 4000;
        }
      }
    });
  }

  /** 诊断：列出模型所有渲染层和纹理，用于定位内嵌水印 */
  private dumpDrawables(): void {
    const core = (this.model as unknown as {
      internalModel?: {
        coreModel: {
          getDrawableCount?: () => number;
          getDrawableId?: (i: number) => string;
          getDrawableTextureIndex?: (i: number) => number;
          getDrawableOpacity?: (i: number) => number;
          getDrawableIds?: () => string[];
          getDrawableTextureIndices?: () => number[];
          getPartCount?: () => number;
          getPartId?: (i: number) => string;
          getPartOpacityById?: (id: string) => number;
          getPartIndex?: (id: string) => number;
          getDrawableParentPartIndex?: (i: number) => number;
          getDrawableRenderOrders?: () => number[];
        };
      };
    })?.internalModel?.coreModel;
    if (!core) {
      console.log("[diag] no coreModel");
      return;
    }
    const count = core.getDrawableCount?.() ?? 0;
    console.log(`[diag] drawable count = ${count}`);
    for (let i = 0; i < count; i++) {
      const id = core.getDrawableId?.(i) ?? "?";
      const tex = core.getDrawableTextureIndex?.(i) ?? -1;
      console.log(`[drawable] ${i}: id=${id} tex=${tex}`);
    }

    // 检查部件透明度（尤其"牌子"部件 Part187）
    const partCount = core.getPartCount?.() ?? 0;
    console.log(`[diag] part count = ${partCount}`);
    for (let i = 0; i < partCount; i++) {
      const id = core.getPartId?.(i) ?? "?";
      if (/牌|Part187|Part18[0-9]/i.test(id) || i < 8) {
        const op = core.getPartOpacityById?.(id) ?? -1;
        console.log(`[part] ${i}: id=${id} opacity=${op}`);
      }
    }

    // 找"牌子"Part187 的子渲染层
    const brandPartIdx = core.getPartIndex?.("Part187") ?? -1;
    console.log(`[diag] Part187 index = ${brandPartIdx}`);
    for (let i = 0; i < count; i++) {
      const parent = core.getDrawableParentPartIndex?.(i) ?? -1;
      if (parent === brandPartIdx) {
        const op = core.getDrawableOpacity?.(i) ?? -1;
        const id = core.getDrawableId?.(i) ?? "?";
        console.log(`[brand-drawable] ${i}: id=${id} parent=${parent} opacity=${op}`);
        try {
          const coreAny = core as unknown as {
            getDrawableVertexUvs?: (i: number) => Float32Array;
            getDrawableVertices?: (i: number) => Float32Array;
            getCanvasWidth?: () => number;
            getCanvasHeight?: () => number;
          };
          const uvs = coreAny.getDrawableVertexUvs?.(i);
          if (uvs) {
            let minU = 1, minV = 1, maxU = 0, maxV = 0;
            for (let k = 0; k < uvs.length; k += 2) {
              minU = Math.min(minU, uvs[k]);
              maxU = Math.max(maxU, uvs[k]);
              minV = Math.min(minV, uvs[k + 1]);
              maxV = Math.max(maxV, uvs[k + 1]);
            }
            console.log(`[brand-uv] ${i}: U=${minU.toFixed(4)}-${maxU.toFixed(4)} V=${minV.toFixed(4)}-${maxV.toFixed(4)}`);
          }
          const verts = coreAny.getDrawableVertices?.(i);
          if (verts) {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (let k = 0; k < verts.length; k += 2) {
              minX = Math.min(minX, verts[k]);
              maxX = Math.max(maxX, verts[k]);
              minY = Math.min(minY, verts[k + 1]);
              maxY = Math.max(maxY, verts[k + 1]);
            }
            const cw = coreAny.getCanvasWidth?.() ?? -1;
            const chh = coreAny.getCanvasHeight?.() ?? -1;
            console.log(`[brand-vert] ${i}: X=${minX.toFixed(1)}-${maxX.toFixed(1)} Y=${minY.toFixed(1)}-${maxY.toFixed(1)} canvas=${cw}x${chh}`);
          }
        } catch {
          // ignore
        }
      }
    }
  }

  /** 模型 JSON 没有 HitAreas 定义，手动用模型包围盒作为点击区域 */
  private setupHitArea(): void {
    if (!this.model) return;
    const bounds = this.model.getBounds();
    this.model.interactive = true;
    this.model.hitArea = new PIXI.Rectangle(bounds.x, bounds.y, bounds.width, bounds.height);
  }

  /** 交互：单击随机动作，双击随机表情 */
  private setupInteractions(): void {
    if (!this.model) return;

    this.model.on("pointertap", () => {
      const now = Date.now();
      if (now - this.lastTapAt < 350) {
        // 双击 → 随机表情
        this.setExpression(randomOf(EXPRESSION_NAMES));
        this.lastTapAt = 0;
      } else {
        // 单击 → 随机动作
        this.playMotion(randomOf(MOTION_NAMES));
        this.lastTapAt = now;
      }
    });

    // 悬停 2 秒 → 偶尔换个表情（轻互动）
    this.model.on("pointerover", () => {
      if (Math.random() < 0.3) {
        this.setExpression(randomOf(EXPRESSION_NAMES));
      }
    });
  }

  /** 空闲随机动作：每 25~45 秒播放一个动作，避免角色呆住 */
  private setupIdleMotions(): void {
    const schedule = () => {
      this.idleTimer = setTimeout(() => {
        if (Math.random() < 0.7) {
          this.playMotion(randomOf(MOTION_NAMES));
        }
        schedule();
      }, 25000 + Math.random() * 20000);
    };
    schedule();
  }

  /**
   * 缩放模型。zoom=1 全身适配窗口；>1 特写（脸部放大，头部对齐窗口上部）
   */
  private fitToWindow(zoom = 1, yRatio = 0.12): void {
    if (!this.model) return;

    const base = this.baseBounds ?? this.model.getLocalBounds();
    if (base.width <= 0 || base.height <= 0) return;

    const baseScale = Math.min(this.width / base.width, this.height / base.height);
    const s = baseScale * zoom;
    this.model.scale.set(s);
    this.model.x = (this.width - base.width * s) / 2 - base.x * s;
    // 特写模式：头部（模型顶部）对齐窗口上部 12% 处，脸部占据画面主体
    this.model.y = this.height * yRatio - base.y * s;
  }

  /**
   * ★ 口型同步 — 将 0-1 的比例映射到 Cubism 参数 ParamMouthOpenY
   */
  setMouthOpen(ratio: number): void {
    const core = this.model?.internalModel.coreModel as
      | { setParameterValueById: (id: string, v: number) => void }
      | undefined;
    core?.setParameterValueById("ParamMouthOpenY", Math.min(1, Math.max(0, ratio)));
  }

  /**
   * 说话嘴型同步：以不规则节奏驱动 ParamMouthOpenY。
   * 聊天回复流式到达时调用 setSpeaking(true)，结束后调用 setSpeaking(false)。
   */
  setSpeaking(active: boolean): void {
    const core = this.model?.internalModel.coreModel as
      | { setParameterValueById: (id: string, v: number) => void }
      | undefined;
    if (!core?.setParameterValueById) return;

    if (active) {
      if (this.speakingTimer) return;
      let phase = 0;
      this.speakingTimer = setInterval(() => {
        phase += 0.8 + Math.random() * 0.7;
        const level = Math.min(1, Math.max(0, Math.abs(Math.sin(phase)) * 0.85 + Math.random() * 0.1));
        core.setParameterValueById("ParamMouthOpenY", level);
      }, 70);
    } else {
      if (this.speakingTimer) {
        clearInterval(this.speakingTimer);
        this.speakingTimer = null;
      }
      core.setParameterValueById("ParamMouthOpenY", 0);
    }
  }

  /**
   * 手动指定布局（全屏聊天用：zoom=1 全身适配当前区域）
   */
  setLayout(zoom: number, yRatio = 0.12): void {
    if (!this.model) return;
    this.fitToWindow(zoom, yRatio);
  }

  /**
   * ★ 脚部微露：模型放大，脚部/鞋子在区域底部露出一部分（人物出镜感）
   * 适用于全屏聊天窗口的模型区
   */
  setShoePeek(): void {
    if (!this.model) return;
    const base = this.baseBounds ?? this.model.getLocalBounds();
    if (base.width <= 0 || base.height <= 0) return;
    // 协调比例：略小于完全显示，避免过大突兀
    const baseScale = Math.min(this.width / base.width, this.height / base.height);
    const s = baseScale * 0.98;
    this.model.scale.set(s);
    this.model.x = (this.width - base.width * s) / 2 - base.x * s;
    // 底部：区域下方露出约 6% 高度（鞋子微露）
    const bottomLocal = base.y + base.height;
    const peek = this.height * 0.06;
    this.model.y = this.height + peek - bottomLocal * s;
    // 顶部：必须让出标题空间（区域高度 8% 以下不放置模型）
    const topY = this.model.y + base.y * s;
    if (topY < this.height * 0.08) {
      this.model.y = this.height * 0.08 - base.y * s;
    }
  }

  /**
   * ★ 完全显示：模型整体缩放适配区域并垂直居中（不裁剪）
   * 适用于全屏聊天窗口的模型区
   */
  setFullBody(): void {
    if (!this.model) return;
    const base = this.baseBounds ?? this.model.getLocalBounds();
    if (base.width <= 0 || base.height <= 0) return;
    const s = Math.min(this.width / base.width, this.height / base.height);
    this.model.scale.set(s);
    this.model.x = (this.width - base.width * s) / 2 - base.x * s;
    this.model.y = (this.height - base.height * s) / 2 - base.y * s;
  }

  /**
   * 调整渲染区域尺寸（全屏聊天时固定模型画布尺寸，保持模型大小不变）
   */
  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.app?.renderer.resize(width, height);
    if (!this.model) return;
    // 按当前聊天模式重新布局，模型大小与当前窗口尺寸下的表现完全一致
    if (this.chatMode) {
      this.fitToWindow(0.62, 0.03);
    } else {
      this.fitToWindow(1.9, 0.12);
    }
  }

  /**
   * 聊天布局切换：打开面板时把模型缩小并贴到窗口顶部（“从面板后探出头”），
   * 关闭时恢复面部特写布局。
   */
  setChatMode(on: boolean): void {
    this.chatMode = on;
    if (on) {
      this.fitToWindow(0.62, 0.03);
    } else {
      this.fitToWindow(1.9, 0.12);
    }
  }

  /**
   * ★ 对话动作匹配：根据聊天中的动作描述（如（生气）（摊手））触发表情/动作/小动作。
   * 动作进入队列串行播放：一次只做一个，做完恢复原始姿态再做下一个，避免叠加。
   */
  playConversationAction(action: ConversationAction | null): void {
    if (!action) return;
    // 动作严格跟随语音/文本触发：不做防重复过滤，保证每次重播动作一致
    console.log("[Furina] conversation action queued:", action.label);
    this.actionQueue.push(action);
    void this.drainActionQueue();
  }

  /** 语音重新播放时清空待播放的动作队列，让动作从头开始 */
  clearActionQueue(): void {
    // 递增代次，让正在跑的旧队列尽快让位
    this.actionEpoch += 1;
    this.actionQueue.length = 0;
  }

  /** 串行执行动作队列（一次一个，动作之间留间隔） */
  private async drainActionQueue(): Promise<void> {
    if (this.actionPlaying) return;
    this.actionPlaying = true;
    try {
      const epoch = this.actionEpoch;
      while (this.actionQueue.length > 0) {
        // 朗读重新开始时，旧队列立即让位
        if (epoch !== this.actionEpoch) break;
        const action = this.actionQueue.shift();
        if (!action) continue;
        await this.playSingleAction(action);
        // 两个动作之间留出间隔，让动作“慢慢来”
        await sleep(600);
      }
    } finally {
      this.actionPlaying = false;
      // 若清空后有新动作到来，自动继续
      if (this.actionQueue.length > 0) void this.drainActionQueue();
    }
  }

  /** 播放单个对话动作：表情→动作（等待完成）→恢复原始姿态 */
  private async playSingleAction(action: ConversationAction): Promise<void> {
    if (action.motion) {
      // 动作本身会驱动身体，手势就不重复叠加
      if (action.expression) this.setExpression(action.expression);
      await this.playMotionAndWait(action.motion);
    } else if (action.expression) {
      this.setExpression(action.expression);
      // 表情停留约 2.2 秒后恢复原始姿态（部件透明度 + 中性表情 + 待机）
      await sleep(2200);
      this.restoreDefaultOpacities();
      this.resetExpressionNeutral();
      this.resumeIdle();
    } else if (action.gesture) {
      await this.playGesture(action.gesture);
    }
  }

  /** 播放一次性动作并等待其完成（超时兜底），完成后由 motionFinish 监听统一复位 */
  private playMotionAndWait(name: string, timeoutMs = 6000): Promise<void> {
    return new Promise((resolve) => {
      const onFinish = (): void => {
        clearTimeout(timer);
        const i = this.motionFinishWaiters.indexOf(onFinish);
        if (i >= 0) this.motionFinishWaiters.splice(i, 1);
        resolve();
      };
      const timer = setTimeout(() => onFinish(), timeoutMs);
      this.motionFinishWaiters.push(onFinish);
      this.resetOnMotionFinish = true;
      this.playMotion(name);
    });
  }

  /** 恢复中性表情（清除生气/脸红/道具表情等残留） */
  private resetExpressionNeutral(): void {
    try {
      const em = (this.model as unknown as {
        internalModel?: { motionManager?: { expressionManager?: { resetExpression?: () => void } } };
      })?.internalModel?.motionManager?.expressionManager;
      em?.resetExpression?.();
    } catch {
      // ignore
    }
  }

  /** 快照模型默认部件透明度（加载时、未播放任何动作前） */
  private snapshotDefaultOpacities(): void {
    const opacities = (this.model as unknown as {
      internalModel?: { coreModel?: { _model?: { drawables?: { opacities?: number[] } } } };
    })?.internalModel?.coreModel?._model?.drawables?.opacities;
    if (opacities) this.defaultOpacities = Array.from(opacities);
  }

  /** 恢复部件默认透明度（清除动作残留的隐藏/显示状态） */
  private restoreDefaultOpacities(): void {
    const opacities = (this.model as unknown as {
      internalModel?: { coreModel?: { _model?: { drawables?: { opacities?: number[] } } } };
    })?.internalModel?.coreModel?._model?.drawables?.opacities;
    if (!opacities || !this.defaultOpacities) return;
    const len = Math.min(opacities.length, this.defaultOpacities.length);
    for (let i = 0; i < len; i++) opacities[i] = this.defaultOpacities[i];
  }

  /** 动作结束后回到待机动画，让模型恢复自然姿态（避免停在动作最后一帧） */
  private resumeIdle(): void {
    const internal = (this.model as unknown as {
      internalModel?: { motionManager?: { definitions?: Record<string, Array<{ Name?: string }>> } };
    })?.internalModel;
    const defs = internal?.motionManager?.definitions;
    if (!defs || !this.model) return;
    for (const group of Object.keys(defs)) {
      const list = defs[group] ?? [];
      const idx = list.findIndex((m) => m.Name === "待机动画");
      if (idx >= 0) {
        void (this.model as unknown as { motion: (g: string, i: number, p?: number) => Promise<boolean> }).motion(group, idx, 1);
        return;
      }
    }
  }

  /** 程序化小动作：点头/摇头/歪头/眨眼/叹气/低头/抬头/扭头/凑近（模型没有对应动作文件时用参数驱动） */
  private playGesture(type: "nod" | "shake" | "tilt" | "blink" | "sigh" | "lookDown" | "lookUp" | "turnAway" | "leanIn"): Promise<void> {
    const core = (this.model as unknown as {
      internalModel?: {
        coreModel: { setParameterValueById?: (id: string, v: number) => void };
      };
    })?.internalModel?.coreModel;
    if (!core?.setParameterValueById) return Promise.resolve();

    if (type === "blink") {
      core.setParameterValueById("ParamEyeLOpen", 0);
      core.setParameterValueById("ParamEyeROpen", 0);
      return new Promise((resolve) => {
        setTimeout(() => {
          core.setParameterValueById("ParamEyeLOpen", 1);
          core.setParameterValueById("ParamEyeROpen", 1);
          resolve();
        }, 160);
      });
    }

    return new Promise((resolve) => {
      const start = performance.now();
      const duration =
        ({ nod: 700, shake: 700, tilt: 900, sigh: 1100, lookDown: 1300, lookUp: 1100, turnAway: 1000, leanIn: 1100 } as Record<string, number>)[type] ?? 800;
      this.gestureUntil = start + duration + 100;
      const reset = (): void => {
        core.setParameterValueById("ParamAngleX", 0);
        core.setParameterValueById("ParamAngleY", 0);
        core.setParameterValueById("ParamAngleZ", 0);
      };
      const step = (): void => {
        const t = Math.min(1, (performance.now() - start) / duration);
        let ax = 0;
        let ay = 0;
        let az = 0;
        switch (type) {
          case "nod":
            ax = Math.sin(Math.PI * t) * 12;
            break;
          case "shake":
            ay = Math.sin(t * Math.PI * 2) * 10;
            break;
          case "tilt":
            az = Math.sin(Math.PI * t) * 14;
            break;
          case "sigh":
            ax = t < 0.35 ? (t / 0.35) * 10 : (1 - (t - 0.35) / 0.65) * 10;
            break;
          case "lookDown":
            ax = 12 * (t < 0.7 ? Math.min(1, t / 0.2) : Math.max(0, 1 - (t - 0.7) / 0.3));
            break;
          case "lookUp":
            ax = -10 * (t < 0.7 ? Math.min(1, t / 0.2) : Math.max(0, 1 - (t - 0.7) / 0.3));
            break;
          case "turnAway":
            ay = -14 * (t < 0.7 ? Math.min(1, t / 0.2) : Math.max(0, 1 - (t - 0.7) / 0.3));
            break;
          case "leanIn":
            ax = 8 * Math.min(1, t / 0.25);
            break;
        }
        core.setParameterValueById("ParamAngleX", ax);
        core.setParameterValueById("ParamAngleY", ay);
        core.setParameterValueById("ParamAngleZ", az);
        if (t < 1) {
          requestAnimationFrame(step);
        } else {
          reset();
          resolve();
        }
      };
      requestAnimationFrame(step);
    });
  }

  /** 播放指定名称的动作（一次性动作播完后由 motionFinish 监听复位到待机姿态） */
  playMotion(name: string): boolean {
    // ★ 注意：Live2DModel.motion() 的参数是 (分组名, 索引)，不是动作名！
    // 必须按 Name 跨所有分组查找
    const internal = (this.model as unknown as {
      internalModel?: {
        motionManager?: {
          definitions?: Record<string, Array<{ Name?: string }>>;
          stopAllMotions?: () => void;
        };
      };
    })?.internalModel;
    const defs = internal?.motionManager?.definitions;
    if (!defs || !this.model) return false;
    for (const group of Object.keys(defs)) {
      const list = defs[group] ?? [];
      const idx = list.findIndex((m) => m.Name === name);
      if (idx >= 0) {
        // ★ 修复动作叠加（"第三只手"）：
        // 1) 恢复部件默认透明度——清除旧动作残留的隐藏/显示状态
        // 2) 停止所有动作（含待机）
        // 3) 用最高优先级强制播放新动作（播完自动回到待机，见 motionFinish 监听）
        this.restoreDefaultOpacities();
        internal?.motionManager?.stopAllMotions?.();
        const result = (this.model as unknown as { motion: (g: string, i: number, p?: number) => Promise<boolean> }).motion(group, idx, 3);
        console.log(`[Furina] playMotion("${name}") -> motion("${group}", ${idx}, force)`, result);
        void result.catch(() => { /* ignore */ });
        return true;
      }
    }
    console.warn("[Furina] motion not found:", name);
    return false;
  }

  /** 切换表情（expressions 目录中的 .exp3.json 名称） */
  setExpression(name: string): void {
    this.model?.expression(name);
  }

  /** 诊断用：读取当前模型缩放 */
  getScale(): number | null {
    return this.model ? this.model.scale.x : null;
  }

  /** 诊断：打印所有异常参数值（|v|>2），定位放大/变形元凶 */
  dumpAbnormalParams(): void {
    const core = (this.model as unknown as {
      internalModel?: {
        coreModel: {
          getParameterCount?: () => number;
          getParameterId?: (i: number) => string;
          getParameterValueById?: (id: string) => number;
        };
      };
    })?.internalModel?.coreModel;
    if (!core?.getParameterCount) return;
    const count = core.getParameterCount();
    const abnormal: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = core.getParameterId?.(i) ?? "?";
      try {
        const v = core.getParameterValueById?.(id) ?? 0;
        if (Math.abs(v) > 2) abnormal.push(`${id}=${v.toFixed(2)}`);
      } catch {
        // ignore
      }
    }
    if (abnormal.length > 0) console.log("[diag] abnormal params:", abnormal.join(" "));
    // 关键动作参数（验证动画/眨眼在驱动）
    const keyParams = ["ParamEyeLOpen", "ParamAngleX", "ParamAngleY", "ParamBodyAngleX", "ParamMouthOpenY"];
    const keyVals = keyParams
      .map((id) => {
        try {
          return `${id}=${(core.getParameterValueById?.(id) ?? 0).toFixed(2)}`;
        } catch {
          return `${id}=?`;
        }
      })
      .join(" ");
    console.log("[diag] key params:", keyVals);
    // 待机动画驱动的自定义参数
    const idleParams = ["Param36", "Param37", "Param128", "Param96", "Param97", "Param45"];
    const idleVals = idleParams
      .map((id) => {
        try {
          return `${id}=${(core.getParameterValueById?.(id) ?? 0).toFixed(1)}`;
        } catch {
          return `${id}=?`;
        }
      })
      .join(" ");
    console.log("[diag] idle params:", idleVals);
  }

  /** 诊断：检查模型注册的动画和表情列表 */
  dumpMotionDefs(): void {
    const internal = (this.model as unknown as {
      internalModel?: {
        motionManager?: {
          definitions?: Array<{ Group?: string; motions?: Array<{ File?: string; Name?: string }> }>;
        };
        expressionManager?: { definitions?: Array<{ Name?: string }> };
        settings?: {
          motions?: Record<string, unknown>;
          expressions?: unknown[];
        };
        motionManager?: {
          motionGroups?: Record<string, Array<unknown>>;
        };
      };
    })?.internalModel;
    const defs = internal?.motionManager?.definitions;
    if (defs) {
      console.log(`[diag] motion definitions keys = ${JSON.stringify(Object.keys(defs))}`);
    } else {
      console.log("[diag] no motion definitions");
    }
    console.log(`[diag] settings.motions keys = ${JSON.stringify(Object.keys(internal?.settings?.motions ?? {}))}`);
    console.log(`[diag] settings.expressions length = ${internal?.settings?.expressions?.length}`);
    // 检查 motion 实际加载状态（motionGroups 值：对象=已加载, null=加载失败, undefined=未加载）
    const groups = internal?.motionManager?.motionGroups;
    if (groups) {
      for (const g of Object.keys(groups)) {
        const list = groups[g] ?? [];
        console.log(
          `[diag] motionGroups.${g} = [${list.map((m) => (m === null ? "null" : m === undefined ? "undef" : "loaded")).join(",")}]`
        );
      }
    }
  }

  /** 销毁资源 */
  destroy(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.speakingTimer) clearInterval(this.speakingTimer);
    this.model?.destroy();
    this.app?.destroy(true, { children: true });
  }
}
