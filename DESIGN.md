# DESIGN.md · Agent-Time 设计系统规范

本规范遵循 Google DESIGN.md 设计令牌标准与 Vercel Web Interface Guidelines，作为 Agent-Time 表现层（Issue #2）全站 UI 实现与代码审查的持久真理源（Single Source of Truth）。

---

## 1. 设计令牌 (Design Tokens)

```yaml
tokens:
  typography:
    fontFamily:
      sans: '"Inter", "Noto Sans SC", -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif'
      mono: '"JetBrains Mono", ui-monospace, "SF Mono", "Cascadia Code", "Consolas", monospace'
    scale:
      xs: { size: '11px', lineHeight: '14px', weight: '500' }
      sm: { size: '12px', lineHeight: '16px', weight: '500' }
      base: { size: '13px', lineHeight: '18px', weight: '400' }
      md: { size: '14px', lineHeight: '20px', weight: '600' }
      lg: { size: '16px', lineHeight: '22px', weight: '700' }
      xl: { size: '20px', lineHeight: '26px', weight: '800' }
      display: { size: '26px', lineHeight: '32px', weight: '800' }

  colors:
    surface:
      page: '#FAF9F5'        # 象牙纸暖白底色 (Claude 核心基调)
      card: '#FFFFFF'        # 卡片纯白
      cardMuted: '#F5F2EB'   # 次级纸质衬底
      sidebar: '#F4EFEA'     # 侧边极窄导航背景
      terminal: '#1F1E1D'    # 代码日志炭黑背景

    border:
      default: '#E5E0D8'     # 暖调主分割线
      subtle: '#F0EAE1'      # 极浅辅助线
      hover: '#D6CEC3'       # 悬停强调线

    text:
      title: '#1F1E1D'       # 标题炭黑墨色
      body: '#494541'        # 正文深茶墨色
      muted: '#827C75'       # 辅助暖灰
      inverse: '#FAF9F5'     # 反色墨白

    state:
      # 三态核心语义 (高对比度、无歧义)
      work:
        primary: '#CC785C'   # Claude 陶土橙 (纯工作产出)
        light: '#F7EAE3'     # 陶土浅衬底
        border: '#B8674D'    # 陶土描边
      wait:
        primary: '#C68A4C'   # 高对比琥珀金 (人机审阅等待卡点)
        light: '#FBF3E8'     # 琥珀浅底
        border: '#A36B32'    # 琥珀描边
      idle:
        primary: '#7A7268'   # 稳重亚麻灰 (系统就绪待命)
        light: '#EEEAE2'     # 亚麻浅底

  spacing:
    xs: '4px'
    sm: '8px'
    md: '12px'
    lg: '16px'
    xl: '24px'
    xxl: '32px'

  radii:
    sm: '4px'
    md: '8px'
    lg: '12px'
    xl: '14px'
    pill: '9999px'

  shadows:
    sm: '0 1px 3px rgba(31, 30, 29, 0.04)'
    md: '0 4px 14px rgba(31, 30, 29, 0.06)'
    drawer: '-6px 0 28px rgba(31, 30, 29, 0.09)'
```

---

## 2. 视觉调性与设计哲学 (Visual Rationale)

1. **人文知性与思考舒适感**：
   - 彻底摒弃冰冷刺眼的纯黑或蓝紫卡片套装，全面继承 Claude 暖调象牙纸（`#FAF9F5`）与陶土橙（`#CC785C`）的知性审美；
   - 降低长时间复盘与代码审计的视觉疲劳，使复杂工程数据呈现出如阅读高质量技术出版物般的沉浸感。

2. **锁定字体（人文知性屏显体）**：
   - 正文与标题统一使用单一字体栈：`"Inter", "Noto Sans SC", -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`；
   - 数字与代码严格绑定等宽字体：`"JetBrains Mono", ui-monospace, "SF Mono", "Cascadia Code", "Consolas", monospace`；
   - 严禁手写散乱字号与字重，全站仅消费令牌中声明的 7 级字阶。

---

## 3. 五大核心交互模块规约

### 模块 1：自研品牌 Logo 与矢量图标
- **品牌 Logo**：定制 44x44px 渐变陶土圆角徽标，内部融合「外圈时钟虚线刻度 + 几何沙漏 + 脉冲时针」，象征 Agent 算力与人类时间的交汇。
- **导航图标**：严禁使用操作系统 Emoji；全量采用统一 1.8px 线宽、20px 规格的现代纯正 SVG 矢量线框图标。

### 模块 2：布局骨架（左导极窄栏 + 弹性下钻抽屉）
- **左侧导航**：固定 68px 宽度，提供核心视图切换；
- **主工作流**：居中自适应宽屏流式排版，最大宽度 1380px；
- **下钻抽屉**：右侧 480px 弹性滑出抽屉，支持点击时间轴或轮次无缝推入，支持按 `ESC` 键平滑收起。

### 模块 3：核心大盘（耗时蒸发漏斗 Time Drop Funnel）
- 一屏讲透因果链路：从「总挂载壁钟时长 100% (28.37h)」出发，逐层扣除「人工交互等待卡点 -60.1% (-17.06h)」与「空闲就绪待命 -15.2% (-4.30h)」，最终沉淀出「有效纯工作净值 24.7% (7.01h)」。
- 彻底纠正「机器很忙」的错觉，用严密一手数据证明「70.7% 的延时积压在人机交接与等待环节」。

### 模块 4：时序交互（全景微缩视口滑块 Brush & Zoom）
- **48px 全景画卷带**：采用高饱和、高对比的三态色块拼接，彻底解决「看不清」问题；
- **滑动视口框**：2px 黑白反差描边，配有左右双向拖拽手柄与居中胶囊标签，支持对任意时段进行无级缩放；
- **甘特列表**：下方联动秒级高精轮次列表，悬停即显微交互高亮，点击立即激活抽屉。

### 模块 5：下钻抽屉（两段式总账 + 慢脚本清单）
- **顶部总账**：固定 4 块微卡，秒级展示模型生成总耗时 (API)、工具调用总耗时 (Tools)、人机交互等待 (Review) 与有效工作率；
- **滚动清单**：按用时倒序罗列具体执行工具，重点标注「慢瓶颈」脚本；点击可展开终端代码块（`#1F1E1D` 炭黑底色），原汁原味展示命令参数、覆盖率与退出状态。
