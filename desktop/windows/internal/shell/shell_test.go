package shell

import "testing"

func TestParseHandshake(t *testing.T) {
	hs, err := ParseHandshake(`{"ready":true,"url":"http://127.0.0.1:51234/?token=abc"}` + "\n")
	if err != nil || !hs.Ready || hs.URL != "http://127.0.0.1:51234/?token=abc" {
		t.Fatalf("ready: %+v %v", hs, err)
	}
	hs, err = ParseHandshake(`{"ready":false,"error":"locked","holder":{"pid":12,"kind":"tui"},"message":"终端版的网课助手正在运行"}`)
	if err != nil || hs.Ready || hs.Holder == nil || hs.Holder.Kind != "tui" || hs.Message == "" {
		t.Fatalf("locked: %+v %v", hs, err)
	}
	bad := []string{"", "not json", `{"ready":true,"url":"http://example.com/?token=a"}`, `{"ready":true,"url":"http://127.0.0.1:1/"}`, `{"ready":false}`}
	for _, line := range bad {
		if _, err := ParseHandshake(line); err == nil {
			t.Errorf("should reject %q", line)
		}
	}
}

func TestNodeMajor(t *testing.T) {
	cases := map[string]int{"24.11.0\r\n": 24, "v20.18.1": 20, "18.20.4": 18}
	for in, want := range cases {
		if got, err := NodeMajor(in); err != nil || got != want {
			t.Errorf("%q: got %d %v", in, got, err)
		}
	}
	if _, err := NodeMajor("'node' is not recognized"); err == nil {
		t.Error("should fail")
	}
}

func TestURLs(t *testing.T) {
	u := "http://127.0.0.1:5/?token=abc"
	if got := APIURL(u, "tools"); got != "http://127.0.0.1:5/api/tools?token=abc" {
		t.Error(got)
	}
	if got := WithShell(u); got != "http://127.0.0.1:5/?token=abc&shell=gui" {
		t.Error(got)
	}
}

func TestRunning(t *testing.T) {
	names, err := Running([]byte(`{"tools":[{"id":"xuexitong","name":"学习通"},{"id":"yuketang","name":"长江雨课堂"},{"id":"autovisor","name":"智慧树"}],
		"state":{"runs":{"autovisor":{"running":true},"xuexitong":{"running":true},"yuketang":{"running":false}}}}`))
	if err != nil || len(names) != 2 || names[0] != "学习通" || names[1] != "智慧树" {
		t.Fatalf("%v %v", names, err)
	}
	if names, _ := Running([]byte(`{"tools":[],"state":{"runs":{}}}`)); len(names) != 0 {
		t.Error(names)
	}
}

func TestScale(t *testing.T) {
	if Scale(960, 144) != 1440 || Scale(720, 96) != 720 || Scale(100, 0) != 100 {
		t.Error("scale")
	}
}
