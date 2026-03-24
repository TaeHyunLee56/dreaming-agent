// jest-dom adds custom jest matchers for asserting on DOM nodes.
// allows you to do things like:
// expect(element).toHaveTextContent(/react/i)
// learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom';

/** CRA Jest가 ESM 전용 react-markdown을 파싱하지 못해 테스트용 스텁 */
jest.mock('react-markdown', () => {
  const React = require('react');
  return {
    __esModule: true,
    default: function MockReactMarkdown({ children }) {
      return React.createElement('div', { className: 'markdown-mock' }, children);
    },
  };
});

jest.mock('remark-gfm', () => ({
  __esModule: true,
  default: () => {},
}));
