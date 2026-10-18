export default {
  providerRuntime: {
    manage: 'Manage authorization and models', manageAccount: 'Manage authorization and models for {name}',
    title: 'Subscription providers', description: 'Connect subscription and free models to your existing API groups.',
    disabled: 'The provider service is not enabled. Complete the provider runtime deployment to connect accounts.',
    name: 'Account name', provider: 'Provider', add: 'Add account', account: 'Provider account',
    connect: 'Authorize account', openLogin: 'Open provider sign-in', pending: 'Waiting for provider authorization…',
    connected: 'Connected', disconnected: 'Authorization required', refresh: 'Refresh list',
    models: 'Available models', loadModels: 'Load models', group: 'OpenAI API group', unassigned: 'Assign a group later',
    import: 'Add models to Sub2API', imported: 'Added {count} accounts. Existing connections were preserved.',
    importHint: 'Models are connected in accounts grouped by their native protocol. Assign an API group before use. For Messages clients such as Claude Code, also enable Messages dispatch in the group settings.',
    pricingHint: 'Provider allowance and group charges are separate. Set group model prices to charge downstream usage; new models may have no default pricing.',
    usage: 'Check allowance', unknown: 'Allowance is unknown', empty: 'No models loaded.',
    error: 'The operation failed. Check the provider service and try again.', noGroup: 'No group assigned',
    protocol: 'Protocol', model: 'Model', allowance: 'Provider allowance', selectAll: 'Select all',
    selectModels: 'Choose at least one model.',
  }
}
