// Mirror of server/rules.js, only used to show the right buttons. The server re-checks everything.
export const digitsFor = (state, role) => (state.format === 'test'
  ? (role === 'bowl' ? [1, 2, 3, 4, 6] : [0, 1, 2, 3, 4, 6])
  : [1, 2, 3, 4, 5, 6]);
export const repeatLimit = (state, role) => (state.format !== 'test' && role === 'bowl' ? 3 : null);
