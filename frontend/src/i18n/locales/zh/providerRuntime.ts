export default {
  providerRuntime: {
    manage: '管理授权与模型', manageAccount: '管理 {name} 的授权与模型',
    title: '订阅模型接入', description: '将订阅、积分及免费模型连接到现有 API 分组。',
    disabled: '供应商服务尚未启用，请先完成 provider runtime 部署，再连接账号。',
    name: '账号名称', provider: '供应商', add: '添加账号', account: '供应商账号',
    connect: '授权账号', openLogin: '打开供应商登录页', pending: '正在等待供应商授权…',
    connected: '已连接', disconnected: '需要授权', refresh: '刷新列表',
    models: '可用模型', loadModels: '加载模型', group: 'OpenAI API 分组', unassigned: '稍后分配分组',
    import: '将模型接入 Sub2API', imported: '已添加 {count} 个账号，已有连接予以保留。',
    importHint: '模型按原生协议分组接入。使用前请分配 API 分组；Claude Code 等 Messages 客户端还需在分组设置中启用 Messages 调度。',
    pricingHint: '平台额度与分组收费独立。需要向下游计费时，请设置分组模型价格；新模型可能没有默认价格。',
    usage: '查询额度', unknown: '额度未知', empty: '尚未加载模型。',
    error: '操作失败，请检查供应商服务后重试。', noGroup: '未分配分组',
    protocol: '协议', model: '模型', allowance: '平台额度', selectAll: '全选',
    selectModels: '请至少选择一个模型。',
  }
}
