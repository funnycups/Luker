# High-Floor Token Scaling Analysis - Crawl模式扩展性分析

## 问题定义

**高楼层token上升**：随着对话进行到数百甚至上千轮，记忆图节点数量不断增加，提取时的token消耗是否也会线性增长？

## Crawl模式 vs One-shot模式对比

### One-shot模式（当前）

```
Token消耗 = 对话批次 + 全部节点详情 + 全部边
          = 固定 + O(N) + O(E)
```

其中：
- N = 节点总数（随楼层线性增长）
- E = 边总数（随楼层超线性增长）

**扩展性曲线**：

| 楼层 | 总节点数 | 总边数 | Token消耗 | 趋势 |
|------|---------|--------|-----------|------|
| 100轮 | 50 | 80 | ~8K | 基线 |
| 500轮 | 200 | 400 | ~27K | 3.4x |
| 1000轮 | 400 | 1000 | ~54K | 6.8x |
| 2000轮 | 800 | 2500 | ~108K | 13.5x |
| 5000轮 | 2000 | 8000 | ~270K | **33.8x** |

**结论**：**严重的线性甚至超线性增长**，不可扩展。

### Crawl模式（新设计）

```
Token消耗 = 对话批次 + top-K简要候选 + 探索的节点详情
          = 固定 + O(1) + O(1)
```

其中：
- top-K是固定常数（默认50）
- 探索的节点数是固定常数（通常5-10个）

**扩展性曲线**：

| 楼层 | 总节点数 | Survey候选 | Explore详情 | Token消耗 | 趋势 |
|------|---------|-----------|------------|----------|------|
| 100轮 | 50 | 50 (全部) | 5 | ~3K | 基线 |
| 500轮 | 200 | 50 (top-50) | 5 | ~3K | **1.0x** |
| 1000轮 | 400 | 50 (top-50) | 5 | ~3K | **1.0x** |
| 2000轮 | 800 | 50 (top-50) | 5 | ~3K | **1.0x** |
| 5000轮 | 2000 | 50 (top-50) | 5 | ~3K | **1.0x** |

**结论**：**完全平坦的O(1)扩展性**，完美可扩展！

## 节省对比

| 楼层 | One-shot | Crawl | 节省比例 |
|------|----------|-------|---------|
| 100轮 | 8K | 3K | 62% |
| 500轮 | 27K | 3K | **89%** |
| 1000轮 | 54K | 3K | **94%** |
| 2000轮 | 108K | 3K | **97%** |
| 5000轮 | 270K | 3K | **99%** |

**关键发现**：楼层越高，Crawl模式的优势越明显！

## 深入分析：Token组成

### Survey阶段（Phase 1）

```javascript
const candidates = buildExtractCandidates(store, schema, {
    limit: 50  // 固定上限
});
```

**Token组成**：
```
对话批次: ~1-2K tokens (固定)
候选列表: 50个 × ~40 tokens/个 = ~2K tokens (固定)
Schema说明: ~500 tokens (固定)
提示词: ~1K tokens (固定)
总计: ~4.5-5.5K tokens
```

**关键点**：候选数量是固定的，不管图有多大！

### Explore阶段（Phase 2）

```javascript
// LLM只请求它真正需要的节点
memory_node_detail("n_eileen")  // 1个节点 ~300 tokens
memory_search_nodes("Eileen")   // 返回5个简要 ~200 tokens
```

**Token组成**：
```
对话批次: ~1-2K tokens (复用)
探索上下文: ~500 tokens
请求的节点详情: 5个 × ~300 tokens = ~1.5K tokens
提示词: ~500 tokens
总计: ~2.5-4K tokens per round
```

**最坏情况**（3轮探索）：~7.5-12K tokens

### Execute阶段（Phase 3）

```javascript
// 只发送探索收集的上下文
const executePrompt = buildExecutePrompt(explorationContext, ...);
```

**Token组成**：
```
对话批次: ~1-2K tokens (复用)
探索结果摘要: ~1K tokens
Schema说明: ~500 tokens
提示词: ~1K tokens
总计: ~3.5-4.5K tokens
```

### 总计（三阶段）

```
Survey: ~5K
Explore: ~3K × 2轮 = ~6K
Execute: ~4K
总计: ~15K tokens (最坏情况)
平均: ~10K tokens (典型情况，2轮探索)
```

**关键**：这个消耗**与图大小无关**！

## 潜在的扩展性问题

虽然Crawl模式基本解决了扩展性问题，但仍有几个细节需要注意：

### 问题1：Edge Summary可能过长

```javascript
// 高连接度节点的edge_summary可能很长
{
  id: "n_protagonist",
  edge_summary: "involved_in: evt_001, evt_002, ..., evt_999"  // 可能上千个边！
}
```

**影响**：如果主角参与了1000个事件，edge_summary会占用大量token。

**解决方案A：智能截断**

```javascript
function buildEdgeSummary(store, nodeId, options = {}) {
    const edges = getNodeEdges(store, nodeId);
    const limit = options.limit || 8;
    const maxLength = options.maxLength || 200;
    
    // 按优先级排序
    const sorted = edges.sort((a, b) => {
        // 1. 最近的边优先
        const recencyA = getEdgeRecency(a);
        const recencyB = getEdgeRecency(b);
        if (recencyA !== recencyB) return recencyB - recencyA;
        
        // 2. 重要关系类型优先
        const priorityA = getRelationPriority(a.type);
        const priorityB = getRelationPriority(b.type);
        return priorityB - priorityA;
    });
    
    // 取top-N，且控制总长度
    const selected = [];
    let currentLength = 0;
    
    for (const edge of sorted.slice(0, limit)) {
        const edgeText = formatEdgeForSummary(edge);
        if (currentLength + edgeText.length > maxLength) {
            const remaining = edges.length - selected.length;
            selected.push(`... and ${remaining} more`);
            break;
        }
        selected.push(edgeText);
        currentLength += edgeText.length;
    }
    
    return selected.join(', ');
}
```

**效果**：
- 限制每个edge_summary最多200字符
- 无论节点有多少边，都只展示最相关的8条
- 超过部分用"... and N more"表示

**解决方案B：添加边计数**

```javascript
{
  id: "n_protagonist",
  edge_summary: "involved_in: evt_998, evt_997, evt_995 ... and 997 more",
  edge_count: 1000,  // 明确告诉LLM总数
  edge_types: {      // 按类型统计
    "involved_in": 950,
    "related": 30,
    "mentor_of": 20
  }
}
```

这样LLM知道：
- 这个节点有很多关系
- 只展示了最近的几条
- 如果需要更多信息，可以用`memory_node_neighbors`获取

### 问题2：候选排序算法的效率

```javascript
function calculateExtractionRelevance(node, messageBatch, weights) {
    // 这个函数需要高效
    // 在2000个节点时不能太慢
}
```

**潜在问题**：如果相关性计算过于复杂，在5000轮（2000节点）时可能变慢。

**解决方案：预计算 + 索引**

```javascript
// 在store中缓存常用指标
store.nodeMetrics = {
    "n_protagonist": {
        edgeCount: 1000,
        lastUpdatedSeq: 4995,
        updateFrequency: 0.95,  // 几乎每轮都更新
        relevanceScore: 0.98    // 预计算的基础相关性
    },
    // ...
};

function calculateExtractionRelevance(node, messageBatch, weights) {
    const metrics = store.nodeMetrics[node.id];
    if (!metrics) return 0;
    
    // O(1)查询，无需遍历边
    const currentSeq = messageBatch[messageBatch.length - 1].seq;
    const recencyScore = 1.0 - Math.min(1.0, (currentSeq - metrics.lastUpdatedSeq) / 100);
    const editableScore = node.editable ? 1.0 : 0.0;
    const connectionScore = Math.min(1.0, metrics.edgeCount / 50);
    
    return recencyScore * weights.recencyWeight
         + editableScore * weights.editableWeight
         + connectionScore * weights.connectionWeight;
}
```

**效果**：
- 排序从O(N × E)降为O(N)
- 即使5000个节点也能快速排序

### 问题3：对话批次本身的长度

```javascript
const messageBatch = recentMessages.slice(-extractBatchTurns);
```

这个**不是问题**，因为：
- `extractBatchTurns`是固定的（默认1）
- 不随楼层增长

但如果用户设置了`extractContextTurns: 10`（提供10轮上下文），在高楼层时也是固定的10轮，不会增长。

## 最坏情况分析

### 极端场景：5000轮对话，2000个节点

**One-shot模式**：
```
对话: 2K
2000个节点详情: 2000 × 120 = 240K
8000条边: 8000 × 4 = 32K
总计: 274K tokens
成本: $0.27 per extraction (以$1/M input计算)
```

**Crawl模式**：
```
Survey: 
  对话: 2K
  50个简要候选: 50 × 40 = 2K
  
Explore (2轮):
  每轮: 对话 + 5个详情 = 2K + 1.5K = 3.5K
  总计: 7K
  
Execute:
  对话 + 上下文 = 2K + 1K = 3K

总计: 2K + 2K + 7K + 3K = 14K tokens
成本: $0.014 per extraction
```

**节省**：**95%**（274K → 14K）

### 超极端场景：10000轮对话，5000个节点

**One-shot模式**：
```
5000个节点: 5000 × 120 = 600K tokens
20000条边: 20000 × 4 = 80K tokens
总计: 682K tokens
成本: $0.68 per extraction
```

**Crawl模式**：
```
仍然是: ~14K tokens
成本: $0.014 per extraction
```

**节省**：**98%**（682K → 14K）

## 结论

### ✅ Crawl模式完全解决了高楼层扩展性问题

1. **Token消耗是O(1)常量**
   - 不随节点数增长
   - 不随边数增长
   - 不随楼层增长

2. **节省比例随楼层增加而增加**
   - 500轮：节省89%
   - 1000轮：节省94%
   - 5000轮：节省99%

3. **需要注意的细节**
   - Edge summary需要智能截断
   - 候选排序需要预计算优化
   - 但这些都是可以解决的小问题

### 📊 扩展性对比图

```
Token消耗随楼层变化：

300K │                                              ╱ One-shot
     │                                          ╱
250K │                                      ╱
     │                                  ╱
200K │                              ╱
     │                          ╱
150K │                      ╱
     │                  ╱
100K │              ╱
     │          ╱
 50K │      ╱
     │  ╱
   0 ├──────────────────────────────────────── Crawl (平坦)
     0    1000    2000    3000    4000    5000 (楼层)
```

### 🎯 Crawl模式是唯一可扩展的长期解决方案

对于超长对话（>1000轮）和大型记忆图（>500节点），Crawl模式不仅节省成本，而且是**必需的**——One-shot模式在这种规模下根本无法承受。

## 实现建议

### 优先级1：基础Crawl实现
- 三阶段流程
- 固定top-K候选
- 基础探索工具

### 优先级2：Edge Summary优化
```javascript
extractCrawlEdgeSummaryMaxLength: 200,  // 每个edge_summary最多200字符
extractCrawlEdgeSummaryLimit: 8,        // 最多显示8条边
```

### 优先级3：候选排序优化
```javascript
// 预计算node metrics
function updateNodeMetrics(store, nodeId) {
    store.nodeMetrics[nodeId] = {
        edgeCount: countNodeEdges(store, nodeId),
        lastUpdatedSeq: node.seqTo,
        relevanceScore: calculateBaseRelevance(node)
    };
}
```

### 优先级4：性能监控
```javascript
// 记录每个阶段的token消耗
store.lastExtractionDebug = {
    mode: 'crawl',
    surveyTokens: 5234,
    exploreTokens: 6891,
    executeTokens: 3456,
    totalTokens: 15581,
    candidateCount: 50,
    inspectedCount: 5,
    graphSize: 2000
};
```

这样可以在生产环境中验证Crawl模式确实保持了O(1)扩展性。
