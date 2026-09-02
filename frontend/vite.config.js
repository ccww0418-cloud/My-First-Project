import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],

  build: {
    outDir: 'dist',
    // 소스맵을 켜면 원본 코드가 S3에 공개됩니다. 프로덕션에서는 끕니다.
    sourcemap: false,
    // 파일명에 해시가 붙어 CloudFront에서 영구 캐싱해도 안전합니다
    // (STEP 11-B의 Cache-Control 설정과 짝을 이룹니다)
    assetsDir: 'assets',
  },

  server: {
    port: 5173,
    /**
     * 로컬 개발용 프록시.
     *
     * 배포 환경은 CloudFront가 /api/* 를 Lambda로 보내주므로 프론트는 상대 경로만 씁니다.
     * 로컬에서도 같은 코드가 동작하게 하려면 여기서 프록시를 걸어주면 됩니다.
     *
     * 사용법:
     *   1) Lambda 함수 URL의 인증 유형을 임시로 NONE으로 변경
     *   2) frontend/.env.local 에 아래처럼 적기
     *        VITE_DEV_PROXY_TARGET=https://xxxx.lambda-url.ap-northeast-2.on.aws
     *   3) npm run dev
     *   4) 개발이 끝나면 반드시 인증 유형을 AWS_IAM으로 되돌리세요
     */
    proxy: process.env.VITE_DEV_PROXY_TARGET
      ? {
          '/api': {
            target: process.env.VITE_DEV_PROXY_TARGET,
            changeOrigin: true,
            secure: true,
            // Lambda 함수 URL은 /api 접두사를 모르므로 벗겨서 보냅니다
            rewrite: (p) => p.replace(/^\/api/, ''),
          },
        }
      : undefined,
  },
});
