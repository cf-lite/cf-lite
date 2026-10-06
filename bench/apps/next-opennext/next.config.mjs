export default {
  async redirects() {
    return [{ source: "/go/example", destination: "https://example.com/", permanent: false }];
  },
};
