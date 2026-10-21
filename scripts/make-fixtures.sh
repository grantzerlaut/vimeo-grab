#!/usr/bin/env sh
# Regenerates the synthetic HLS test stream in test/fixtures/hls.
# H.264 with B-frames + separate AAC audio, packaged like Vimeo's fMP4 HLS.
# Requires ffmpeg. The output is committed so tests don't need ffmpeg.
set -eu
cd "$(dirname "$0")/../test/fixtures/hls"
ffmpeg -v error -y \
  -f lavfi -i "testsrc2=size=192x108:rate=24" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000" \
  -t 5 -map 0:v -map 1:a \
  -c:v libx264 -preset veryfast -profile:v high -g 24 -bf 2 -pix_fmt yuv420p -b:v 120k \
  -c:a aac -b:a 64k \
  -f hls -hls_time 2 -hls_playlist_type vod -hls_segment_type fmp4 \
  -var_stream_map "v:0,agroup:aud a:0,agroup:aud" \
  -master_pl_name master.m3u8 -hls_fmp4_init_filename init.mp4 \
  -hls_segment_filename "stream_%v/seg%d.m4s" "stream_%v/index.m3u8"

# Replace ffmpeg's master playlist with one shaped like Vimeo's: two video
# renditions sharing a separate audio group, plus a subtitle group.
cat > master.m3u8 <<'M3U8'
#EXTM3U
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",URI="subs/en.m3u8",AUTOSELECT=YES,DEFAULT=NO
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-high",NAME="English",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="en",CHANNELS="1",URI="stream_1/index.m3u8?st=audio"

#EXT-X-STREAM-INF:SUBTITLES="subs",BANDWIDTH=140772,AVERAGE-BANDWIDTH=121532,RESOLUTION=192x108,FRAME-RATE=24.000,CODECS="avc1.64000b,mp4a.40.2",AUDIO="audio-high"
stream_0/index.m3u8?st=video
#EXT-X-STREAM-INF:SUBTITLES="subs",BANDWIDTH=90000,AVERAGE-BANDWIDTH=80000,RESOLUTION=128x72,FRAME-RATE=24.000,CODECS="avc1.64000b,mp4a.40.2",AUDIO="audio-high"
stream_0/index.m3u8?st=video&small=1
M3U8
