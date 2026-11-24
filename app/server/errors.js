class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.name = "AppError";
  }
  status;
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
class UnityConfigurationRequired extends AppError {
  constructor(message) {
    super(409, message);
    this.name = "UnityConfigurationRequired";
  }
}
export {
  AppError,
  UnityConfigurationRequired,
  errorMessage
};
