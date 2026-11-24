function canUsePlugin(user, pluginId) {
  return !user.disabled && (user.role === "public" || user.role === "admin" || user.allowedPlugins.includes(pluginId));
}
function canAccessTask(user, task) {
  return (user.role === "admin" || task.ownerId === user.id) && canUsePlugin(user, task.pluginId);
}
function updatePluginId(kind) {
  return kind === "h5" ? "h5-sync" : "finance-sync";
}
export {
  canAccessTask,
  canUsePlugin,
  updatePluginId
};
