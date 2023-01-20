export const groupBy = <T>(xs: T[], key: string): Record<string, T[]> => {
  return xs.reduce((rv, x) => {
    // @ts-ignore
    (rv[x[key]] = rv[x[key]] || []).push(x);
    return rv;
  }, {});
};
