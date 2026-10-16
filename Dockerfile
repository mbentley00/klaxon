FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
# The local speech model for read-along in browsers without a usable speech
# service (Brave, Firefox): served from here rather than a third party's site.
# Fetched at build time so its 40 MB stays out of git. A failed download only
# means readers fall back to the public copy (see MODAQ's VoskSpeechEngine).
RUN mkdir -p public/models &&     (wget -q -O public/models/vosk-model-small-en-us-0.15.tar.gz       https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-us-0.15.tar.gz      || rm -f public/models/vosk-model-small-en-us-0.15.tar.gz)
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server/index.js"]
