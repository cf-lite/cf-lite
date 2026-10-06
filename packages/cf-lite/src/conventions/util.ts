/** Import specifier, relative to `.cf-lite/`, for a project-relative file (extension stripped for ts/js). */
export const imp = (file: string) => "../" + file.replace(/\.(tsx|ts|jsx|js)$/, "");
