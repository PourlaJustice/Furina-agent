// Live2D 动作与表情清单（桌宠交互 / 右键菜单共用）
// 独立成模块：菜单窗口引用它时不会把整个 PixiJS/Live2D 库打进包

/** 可用动作（模型 motions/ 目录） */
export const MOTION_NAMES = ["摊手动画", "变芒", "变荒", "待机动画"] as const;

/** 可用表情（模型 expressions/ 目录） */
export const EXPRESSION_NAMES = [
  "星星", "小脸红", "生气", "哭", "捂嘴", "托脸",
  "呆毛电风扇", "喝饮料", "拿蛋糕", "拿勺子", "猫猫嘴", "汗",
  "大聪明", "帽子", "走路切换", "鱼鱼",
] as const;
