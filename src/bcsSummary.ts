export function crewTypeSummaryRows(
  crews: ReadonlyArray<{ uavType: string }>,
  uavTypes: readonly string[],
): Array<[string, number]> {
  return uavTypes.flatMap((uavType) => {
    const count = crews.filter((crew) => crew.uavType === uavType).length;
    return count > 0 ? [[`Екіпажів — ${uavType}`, count] as [string, number]] : [];
  });
}
