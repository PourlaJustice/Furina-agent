// 对话动作匹配器
// 把聊天回复括号中的动作描述（如（生气）（摊手）（叹气）（压低声音））映射到
// 芙宁娜模型实际拥有的动作（motions/）与表情（expressions/）。
// 匹配不到的括号内容也会触发一个轻柔的眨眼，保证括号内容始终有回应。

function randomOf<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export interface ConversationAction {
  /** 匹配到的表情名（expressions/ 目录） */
  expression?: string;
  /** 匹配到的动作名（motions/ 目录） */
  motion?: string;
  /** 模型没有对应动作文件时，用参数驱动的小动作 */
  gesture?: "nod" | "shake" | "tilt" | "blink" | "sigh" | "lookDown" | "lookUp" | "turnAway" | "leanIn";
  /** 原始动作描述 */
  label: string;
}

/** 表情关键词表（顺序即优先级，先匹配先生效） */
const EXPRESSION_RULES: Array<[RegExp, string]> = [
  [/生气|愤怒|恼火|气鼓鼓|气哼哼|横眉|瞪眼/, "生气"],
  [/哭|泪|委屈|抽泣|哽咽|难过|伤心|泫然/, "哭"],
  [/脸红|害羞|娇羞|羞涩|不好意思|羞赧|含羞/, "小脸红"],
  [/捂嘴|掩口|偷笑|忍俊不禁|忍笑|抿嘴笑|噗嗤|笑出声/, "捂嘴"],
  [/托脸|托腮|托着下巴|撑着下巴|托起下巴|支着下巴|抚着下巴|思考|思索|琢磨|沉吟|沉思|想了想|想了一下/, "托脸"],
  [/眼睛发亮|眼前一亮|闪亮|冒星星|星星眼|眼里发光|眼睛亮晶晶|亮晶晶|眼里闪着光|眼睛闪闪|闪亮亮/, "星星"],
  [/汗|尴尬|无语|无奈|黑线|窘迫|窘/, "汗"],
  [/哼|猫猫嘴|傲娇|嘴硬|别扭/, "猫猫嘴"],
  [/得意|骄傲|炫耀|大聪明|扬扬得意|得意洋洋|沾沾自喜|狡黠|坏笑/, "大聪明"],
  [/喝饮料|抿一口|喝一口|品茶|饮茶|小口喝/, "喝饮料"],
  [/蛋糕|甜点|马卡龙|甜品/, "拿蛋糕"],
  [/勺子|通心粉/, "拿勺子"],
  [/呆毛/, "呆毛电风扇"],
  [/鱼鱼|幽光星星/, "鱼鱼"],
  [/帽子|戴上.*帽/, "帽子"],
];

/** 动作关键词表（motions/ 目录中的动作文件） */
const MOTION_RULES: Array<[RegExp, string]> = [
  [/摊手|摊开手|一摊手|耸肩|耸耸肩|两手一摊|双手一摊/, "摊手动画"],
  [/变芒/, "变芒"],
  [/变荒/, "变荒"],
];

/** 小动作关键词表（参数驱动：点头/摇头/歪头/眨眼/叹气/低头/抬头/扭头/凑近） */
const GESTURE_RULES: Array<[RegExp, "nod" | "shake" | "tilt" | "blink" | "sigh" | "lookDown" | "lookUp" | "turnAway" | "leanIn"]> = [
  [/点头|颔首|点点头|连连点头/, "nod"],
  [/摇头|晃脑|摇摇头/, "shake"],
  [/歪头|歪着|歪歪|侧头|偏头|歪了歪/, "tilt"],
  [/眨眼|眨眨|wink|挤眉/, "blink"],
  [/叹气|叹息|叹了口/, "sigh"],
  [/低头|低下头|垂下头|垂眸|垂下眼帘/, "lookDown"],
  [/抬头|抬起头|扬起头|仰头|一扬头|扬头|昂头|仰起头/, "lookUp"],
  [/扭头|别过头|转开脸|侧过脸/, "turnAway"],
  [/凑近|靠近|俯身|探身/, "leanIn"],
  [/压低声音|小声|轻声|低语|悄悄|附耳/, "lookDown"],
  [/微笑|轻笑|笑了笑|温柔|嘴角上扬|弯起嘴角/, "nod"],
];

/** 提取回复中的动作片段：全角/半角括号或 *星号* 包裹的内容 */
export function extractActionSegments(text: string): string[] {
  const out: string[] = [];
  const re = /（[^（）]*）|\([^()]*\)|\*[^*]+\*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(m[0]);
  }
  return out;
}

/** 把一段动作描述解析成可执行的模型动作（匹配不到时回退为轻轻眨眼） */
export function parseConversationAction(segment: string): ConversationAction | null {
  const inner = segment
    .replace(/^[（(\[*＊]+/, "")
    .replace(/[）)\]*＊]+$/, "")
    .trim();
  if (!inner) return null;

  const action: ConversationAction = { label: inner };
  for (const [re, exp] of EXPRESSION_RULES) {
    if (re.test(inner)) {
      action.expression = exp;
      break;
    }
  }
  for (const [re, motion] of MOTION_RULES) {
    if (re.test(inner)) {
      action.motion = motion;
      break;
    }
  }
  for (const [re, gesture] of GESTURE_RULES) {
    if (re.test(inner)) {
      action.gesture = gesture;
      break;
    }
  }
  if (!action.expression && !action.motion && !action.gesture) {
    // 兜底：没有匹配到具体动作时，随机做一个轻柔小动作（歪头/点头/眨眼），保证有可见回应
    action.gesture = randomOf(["tilt", "nod", "blink"]);
  }
  return action;
}