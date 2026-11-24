function dayTimestamp(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-")) return NaN;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp : NaN;
}
function parseUpdateDates(value) {
  if (typeof value !== "string") throw new Error("dates 必须是逗号分隔的日期字符串。");
  const dates = value.split(",").map((day) => day.trim());
  if (dates.length > 31 || dates.some((day) => !Number.isFinite(dayTimestamp(day)))) throw new Error("日期须为合法 YYYY-MM-DD，最多31天，不可留空。");
  for (let index = 1; index < dates.length; index++) {
    if (dayTimestamp(dates[index]) - dayTimestamp(dates[index - 1]) !== 864e5) throw new Error("日期必须唯一、升序且逐日连续，不自动扩展日期。");
  }
  return dates;
}
function initialDateSelection(value) {
  if (value !== void 0) {
    const dates = value.split(",").map((day2) => day2.trim());
    return { range: dates.length > 1, start: dates[0], end: dates[dates.length - 1] };
  }
  const date = /* @__PURE__ */ new Date();
  date.setDate(date.getDate() - 1);
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return { range: false, start: day, end: day };
}
function selectedDates(selection) {
  const start = dayTimestamp(selection.start);
  const end = selection.range ? dayTimestamp(selection.end) : start;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { value: "", error: "请选择有效的更新日期。" };
  const count = (end - start) / 864e5 + 1;
  if (count < 1) return { value: "", error: "结束日期不能早于开始日期。" };
  if (count > 31) return { value: "", error: "一次最多更新连续 31 天，请缩小日期范围。" };
  return { value: Array.from({ length: count }, (_, index) => new Date(start + index * 864e5).toISOString().slice(0, 10)).join(",") };
}
export {
  dayTimestamp,
  initialDateSelection,
  parseUpdateDates,
  selectedDates
};
