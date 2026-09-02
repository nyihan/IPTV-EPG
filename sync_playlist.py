import requests
import re
import json
import sys
import os

if sys.stdout.encoding != 'utf-8':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

USER_ID = "cueo4y"
ORIGIN_URL = f"https://iu-ott.site/?id={USER_ID}"
EPG_URL = "https://raw.githubusercontent.com/nyihan/IPTV-EPG/main/epg.xml.gz"

HEADERS = {
    'User-Agent': f'OTT Navigator/1.6.8.3 (Linux;Android 11; {USER_ID}; 12345678)',
    'Accept': '*/*',
    'Connection': 'keep-alive'
}

def clean_name(s):
    if not s:
        return ""
    s = s.lower()
    s = re.sub(r'-\s*vpn', '', s)
    s = re.sub(r'\b(hd|fhd|uhd|4k|sd|tv|plus)\b', '', s)
    s = re.sub(r'\[.*?\]|\(.*?\)', '', s)
    s = re.sub(r'[^a-z0-9]', '', s)
    return s.strip()

def sync_and_prepare_playlist(output_path="final_playlist.m3u"):
    print(f"Connecting to origin server with residential User-Agent for ID: {USER_ID}...")
    
    try:
        resp = requests.get(ORIGIN_URL, headers=HEADERS, timeout=30)
    except Exception as e:
        print(f"Connection error: {e}")
        return False
        
    if resp.headers.get('X-Security-Trap') == 'Active':
        print("Error: Server Security Trap is Active! Aborting.")
        return False
        
    if "#EXTM3U" not in resp.text or len(resp.text) < 10000:
        print("Error: Invalid or incomplete playlist received.")
        return False

    # Load manual channel mapping
    mapping = {}
    mapping_file = "channel_mapping.json"
    if os.path.exists(mapping_file):
        with open(mapping_file, "r", encoding="utf-8") as f:
            mapping = json.load(f)
        print(f"Loaded {len(mapping)} manual channel mappings from {mapping_file}.")

    lines = resp.text.splitlines()
    total_channels = 0
    mapped_count = 0
    output_lines = [f'#EXTM3U x-tvg-url="{EPG_URL}" url-tvg="{EPG_URL}"']
    
    current_extinf = ""
    current_props = []

    for line in lines:
        line_str = line.strip()
        if not line_str:
            continue
            
        if line_str.startswith('#EXTM3U'):
            continue
        elif line_str.startswith('#EXTINF:'):
            current_extinf = line_str
        elif line_str.startswith('#') and not line_str.startswith('#EXTINF'):
            current_props.append(line_str)
        elif line_str.startswith('http') and current_extinf:
            total_channels += 1
            name_m = re.search(r',(.+)$', current_extinf)
            ch_name = name_m.group(1).strip() if name_m else ""
            
            # Check mapping
            tvg_id = ""
            if ch_name in mapping and mapping[ch_name]:
                tvg_id = mapping[ch_name]
            else:
                # check clean name match
                c_name = clean_name(ch_name)
                for k, v in mapping.items():
                    if v and clean_name(k) == c_name:
                        tvg_id = v
                        break
            
            final_extinf = current_extinf
            if tvg_id:
                mapped_count += 1
                if 'tvg-id=' in final_extinf:
                    final_extinf = re.sub(r'tvg-id="[^"]*"', f'tvg-id="{tvg_id}"', final_extinf)
                else:
                    last_comma = final_extinf.lastIndexOf(',') if hasattr(final_extinf, 'lastIndexOf') else final_extinf.rfind(',')
                    if last_comma != -1:
                        final_extinf = final_extinf[:last_comma] + f' tvg-id="{tvg_id}"' + final_extinf[last_comma:]
            
            output_lines.append(final_extinf)
            output_lines.extend(current_props)
            output_lines.append(line_str)
            
            current_extinf = ""
            current_props = []

    print(f"Total channels preserved (100% kept, zero dropped): {total_channels}")
    print(f"Channels mapped with EPG tvg-id: {mapped_count}")
    
    with open(output_path, "w", encoding="utf-8") as f:
        f.write('\n'.join(output_lines) + '\n')
        
    print(f"Successfully generated clean {output_path} ({len(output_lines)} lines).")
    return True

if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "final_playlist.m3u"
    sync_and_prepare_playlist(out)
