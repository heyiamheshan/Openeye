import cv2

MAX_INDEX = 5

print("Scanning camera indexes 0.." + str(MAX_INDEX) + "...\n")
for index in range(MAX_INDEX + 1):
    cap = cv2.VideoCapture(index)
    if cap.isOpened():
        ok, frame = cap.read()
        if ok:
            h, w = frame.shape[:2]
            print(f"Index {index}: available, frame size {w}x{h}")
        else:
            print(f"Index {index}: opened but could not read a frame")
    else:
        print(f"Index {index}: not available")
    cap.release()
