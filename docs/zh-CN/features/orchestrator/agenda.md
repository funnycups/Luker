# Agenda 模式

Agenda 用规划 Agent 组织流程。规划 Agent 维护待办清单，按中间结果决定调用哪些 Agent、调用几次以及何时结束，最后由收尾 Agent 合成编排结果。

## 什么时候用

Agenda 适用于以下情况：

- 某些步骤只在条件满足时运行，例如先判断用户输入是否越界，越界才启动约束检查。
- 下一步调用哪个 Agent 取决于上一步的输出，无法提前画出完整流程。
- 需要由一个规划 Agent 统一协调多个工作 Agent。

两种模式的差别在于由谁选择 Agent：Spec 由阶段表决定，Agenda 由规划 Agent 决定。

## 工作方式

```d2
direction: down

start: "新回合开始" {
  shape: oval
  style.fill: "#e8f5e9"
}

loop: "规划 Agent 调度" {
  style.fill: "#e1f5ff"

  driver: "规划 Agent\n读取已完成的工作 · 更新待办清单 ·\n派遣工作 Agent · 决定何时收尾" {
    style.fill: "#fffde7"
  }

  pool: "工作 Agent 池" {
    style.fill: "#fff3e0"
    a: "场景整理" {
      style.fill: "#fffde7"
    }
    b: "世界书约束" {
      style.fill: "#fffde7"
    }
    c: "情节规划" {
      style.fill: "#fffde7"
    }
    d: "审查" {
      style.fill: "#fffde7"
    }
  }

  driver -> pool: "派遣一个或多个（可并行）"
  pool -> driver: "返回结果 · 必要时重新规划"
}

finalizer: "收尾 Agent 写出编排结果" {
  style.fill: "#c8e6c9"
}

out: "注入主模型的提示词" {
  shape: oval
  style.fill: "#f3e5f5"
}

start -> loop.driver
loop.driver -> finalizer: "结束"
finalizer -> out
```

1. 规划 Agent 读取最近聊天和用户消息。
2. 它维护一份待办清单，记录已完成和待处理的事项。
3. 它从工作 Agent 池中选择一个或多个 Agent，分配任务。
4. 它读取返回结果，更新清单，决定继续派遣还是结束。
5. 结束时，由指定的收尾 Agent 把结果合成编排结果，注入主模型。

工作 Agent 不绑定在固定阶段上：是否调用、调用几次、以什么顺序调用，都由规划 Agent 决定。

## 默认流程

出厂配置自带一个规划 Agent 和一组工作 Agent：

- **场景整理**：提取用户意图、当前张力和可能的发展方向。
- **世界书约束**：从已激活的条目中选出本回合真正有影响的设定与文风要求。
- **情节规划**：规划下一拍的节拍和决策点，保持因果与角色独立性。
- **审查**：检查连续性、角色偏离、缺失约束和不符合世界规则的因果。
- **收尾**：把审查通过的产出合成一段简短的编排指引。

规划 Agent 可以并行派遣多个工作 Agent，也可以根据结果重新规划。它决定何时停止，收尾 Agent 只执行一次。

## 开始使用

1. 在扩展抽屉把执行模式设为 **Agenda**。
2. 打开编排编辑器，检查规划 Agent 的系统提示词与任务模板。
3. 查看工作 Agent 池，按需调整每个 Agent 的职责、提示词和模型。
4. 设置规划轮数、并发数和总调用次数上限。
5. 正常聊天，在运行面板查看规划过程和每个工作 Agent 的输出。

需要改流程时，优先用 [AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio) 描述目标，让 AI 修改规划逻辑或 Agent 池。

## 编辑器

左侧是规划 Agent 的配置：API 连接、聊天补全预设、系统提示词和任务模板。右侧是工作 Agent 池，每个 Agent 有自己的系统提示词、用户提示词模板和可选的模型覆写。

规划 Agent 通过工具调用派遣工作 Agent，因此所用连接需要支持函数调用。OpenAI、Claude 与 Gemini 均支持。

## 运行上限

Agenda 提供三项运行上限：

- 规划 Agent 的最大轮数。
- 同时运行的工作 Agent 数量。
- 单次运行中所有工作 Agent 的调用总数。

达到任一上限时强制结束。

## 与 Spec 互转

编辑器提供把 Agent 池复制到另一模式的按钮。转换只迁移 Agent，不迁移调度逻辑：

- 从 Spec 转到 Agenda，阶段顺序会丢失，需要在规划 Agent 的提示词里重新描述调度规则。
- 从 Agenda 转到 Spec，动态派遣无法完整映射为固定阶段，需要手动决定阶段划分。

## 运行面板

运行面板按规划轮次展示。每一轮是一张卡片，本轮派遣的工作 Agent 显示为子卡片，展开可以查看推理、输入和输出。

重点关注：

- 规划 Agent 是否派错了 Agent，或漏掉必要步骤。
- 是否在同一件事上反复派遣，迟迟不结束。
- 收尾 Agent 的产出是否包含本回合真正需要的信息。

面板顶部的导出按钮可以把整次运行保存为 JSON，便于反馈问题。

## 配置

- **规划最大轮数**：规划 Agent 的调度轮数上限。
- **最大并发 Agent 数**：同时运行的工作 Agent 数量。
- **总执行次数上限**：单次运行中所有工作 Agent 的调用总数。
- **规划 API 与提示词预设**：规划 Agent 使用的连接与聊天补全预设。下拉框旁的问号按钮可以一键导入内置预设。
- **规划系统提示词与任务模板**：定义它的工作方式。
- **收尾 Agent**：结束时由哪个 Agent 产出编排结果。
- **工作 Agent 池**：每个 Agent 的提示词、模型和职责。

## 相关页面

- [多 Agent 编排概览](/zh-CN/features/orchestrator/) —— 通用配置、触发时机与角色卡绑定
- [AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio) —— 用自然语言修改规划逻辑与 Agent 池
- [Spec 模式](/zh-CN/features/orchestrator/spec) —— 固定阶段的默认模式
- [Loop 模式](/zh-CN/features/orchestrator/loop) —— 单 Agent 工具循环
- [自定义工具](/zh-CN/features/orchestrator/custom-tools) —— 给工作 Agent 增加内置之外的能力
