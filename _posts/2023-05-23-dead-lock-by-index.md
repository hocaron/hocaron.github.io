---
layout: post
title:  "[트러블슈팅 - DB] 인덱스(Index)와 데드락(DeadLock)"
comments: true
tags: Troubleshooting
excerpt_separator: <!--more-->
lang: ko
permalink: /dead-lock-by-index/
---

![](https://velog.velcdn.com/images/haron/post/329afb75-8be4-47ed-ab19-cb087ec1a934/image.png)

역시 [해치웠나](https://velog.io/@haron/%EC%99%B8%EB%9E%98%ED%82%A4Foreign-Key%EC%99%80-%EB%8D%B0%EB%93%9C%EB%9D%BDDeadLock-%EA%B7%B8%EB%A6%AC%EA%B3%A0-%EC%BF%BC%EB%A6%AC-%EC%A7%80%EC%97%B0-%EC%8B%A4%ED%96%89-eruedsy4)를 외치면 안 되는 것인가... 또 울기 시작한 페페... (그만 울어잇!)
의미있는 경험으로 남기기위해 기록해보자.
![](https://velog.velcdn.com/images/haron/post/1687c152-873d-425f-96f9-174735a9c262/image.png)

## 데드락이 발생하는 상황 다시 재현

### 현재 테이블 상태
```sql
CREATE TABLE parent
(
    id             bigint        not null primary key,
    name           varchar(255)  null,
    updated_at     datetime(6)   null
);

CREATE TABLE child
(
    id           bigint          not null primary key,
    name         varchar(255)    null,
    parent_id    bigint          null,
    CONSTRAINT parent_id_unique UNIQUE (parent_id)
);


CREATE TABLE child_index
(
    id           bigint          not null primary key,
    name         varchar(255)    null,
    parent_id    bigint          null,
);
CREATE INDEX parent_id ON child_index (parent_id);

INSERT INTO parent VALUES (1, 'parent_1', NOW());
```
1. parent 테이블의 id를 index로 가지고 있는 child_index 테이블 생성(외래키는 운영에서 삭제되어서 테스트시 고려하지 않습니다)
2. parent 테이블의 id를 유니크 키로 가지고 있는 child 테이블 생성(마찬가지로 외래키 고려하지 않습니다.)
2. parent 테이블에 테스트 데이터 적재

### 그럼 이제 데드락을 발생시켜 보자
### index 걸려있는 row delete →  index 걸려있는 자식 row insert가 두개의 세션에서 수행되면, 데드락이 발생 💣
![](https://velog.velcdn.com/images/haron/post/bc47166e-b1b7-4f30-ac1f-09932cb38ff7/image.png)

|TX1|TX2|lock|
|------|---|---|
|BEGIN ;  <br> DELETE FROM child_index WHERE parent_id = 2;||(1) child X Lock 인데, TX2에서 X Lock 획득 가능할까 🤔|
||BEGIN ;  <br> DELETE FROM child_index WHERE parent_id = 2;|(2) child X Lock|
|INSERT INTO child_index VALUES ('1', 'name2', 2);||(3) child X,INSERT_INTENTION Lock 대기|
||INSERT INTO child_index VALUES ('2', 'name2', 2);|(4) child X,INSERT_INTENTION Lock 대기|
||Deadlock found when trying to get lock; try restarting transaction|(4) child X lock 이 필요하지만, (2) 에서 child X lock 상태 <br> (4) 해소를 위해서 (3) 해소 필요 <br> -> (3) 해소 위해서 TX2 커밋 필요 <br> -> TX2 커밋하려면 (4) 해소 필요 <br> -> 데드락 발생|

## 운영환경에서 데드락이 발생하는 로직을 살펴보자

### index 걸려있는 row delete →  index 걸려있는 자식 row insert가 두개의 세션에서 수행되면, 데드락이 발생 💣
```sql
SELECT * from parent WHERE id = 1;
INSERT INTO child VALUES (1, 'child_1', 1);
DELETE FROM child_index WHERE parent_id = 1;
INSERT INTO child_index VALUES (1, 'child_index_1', 1);
UPDATE parent SET  updated_at = NOW() WHERE id = 1;
```

```java
  @Transactional
  public void createChildAndChildIndex (long parentId) {

    var parent = parentRepository.findById(parentId);
    
    childIndexRepository.deleteByParent(parent);
    childIndexRepository.save(new Child_Index('child_index_1', parent));

  }
```
- 한가지 신기한 점은 delete 하려는 데이터가 없을 때, 데드락이 발생한다.
- delete 하려는 데이터가 있는 경우에는 같은 로직을 수행하면 락을 잡을 때까지 기다리게 된다.

## 원인은 알았고, 서버에서 데드락을 해결할 수 있는 방법을 고민해보자
### ❎ 첫번째 시도, 존재하는 경우에만 row 삭제
```java
  @Transactional
  public void createParent (long parentId) {

    var parent = parentRepository.findById(parentId);
    
    if(childIndexRepository.findByParent(parent).isPresent()) {
        childIndexRepository.deleteByParent(parent);
    }
    childIndexRepository.save(new Child_Index('child_index_1', parent));
  }
```
- 무조건 delete 하는 로직으로 인한 배타락은 방지 가능하다.
- 동시 요청시에 childIndexRepository.findByParent 에 데이터가 없는 경우로 분기처리되는 경우, 데이터가 2배로 적재될 수 있다.
  - 300ms 로 쓰레드 sleep() 걸어서 테스트 결과 2배로 쌓이는 것을 확인

### ✅ 두번째 시도, 존재하는 경우에만 row 삭제하면서 유니크 조건 추가
```sql
CREATE TABLE child_index
(
    id           bigint          not null primary key,
    name         varchar(255)    null,
    parent_id    bigint          null,
    CONSTRAINT parent_id_unique UNIQUE (parent_id)
);
CREATE INDEX parent_id ON child_index (parent_id);
```
- 동시 요청시에 childIndexRepository.findByParent 에 데이터가 없는 경우로 분기처리되는 경우, 후에 커밋되어 적재된 데이터는 중복키 에러 처리된다.

### ❎ 세번째 시도, Redis 에 동시성 제어를 위한 키 추가
- 간헐적인 데드락이고, 위 서비스에서 Redis를 사용하지 않아 캐시 리소스가 더 클 것 같아 나가리!

### ❎ 네번째 시도, 요청 제한
- Bucket4j를 이용해서 클라이언트가 특정 시간 프레임 내에 만들 수 있는 API 호출 수를 제한한다.
- 위 서비스는 서버가 여러대인 경우라서 다른 서버로 동시 요청이 들어가는 경우, 데드락 방지 불가능

## 정리
1. 데이터가 없는 경우, 삭제 쿼리를 날리면 delete, select 는 가능하지만 insert 시에 락을 기다리게 된다.
2. 락이 궁금하다면, [MySQL 공식문서 중 InnoDB Lock 메뉴얼](https://dev.mysql.com/doc/refman/8.0/en/innodb-locking.html#innodb-record-locks)을 참고해보자. (예제와 함께 정리가 너무 잘 되어있는 것을 볼 수 있다.)

### 흥미로운 실험
#### 인덱스가 걸린 컬럼 기준으로 쿼리
- 데이터가 있는 경우에는, 2번째 트랜잭션에서 delete 시에 락 획득을 기다린다.
```sql
BEGIN ;
DELETE FROM child_index WHERE parent_id = 1;
INSERT INTO child_index VALUES (1, 'child_index_1', 1);
COMMIT ;
```
- 데이터가 없는 경우에는, 2번째 트랜잭션에서 delete 시에 락 획득이 바로 가능하다.
```sql
BEGIN ;
DELETE FROM child_index WHERE parent_id = 1;
INSERT INTO child_index VALUES (1, 'child_index_1', 1);
COMMIT ;
```
#### 인덱스가 걸리지 않은 컬럼 기준으로 쿼리
- 데이터가 있는 / 없는 경우, 2번째 트랜잭션에서 delete 시에 락 획득을 기다린다.
```sql
BEGIN ;
DELETE FROM child_index WHERE name = 'child_index_2';
INSERT INTO child_index VALUES (1, 'child_index_1', 1);
COMMIT ;
```

### 기록용
<details>
<summary>SHOW ENGINE innodb STATUS;</summary>
  *** (1) TRANSACTION:TRANSACTION 13034, ACTIVE 6 sec insertingmysql tables in use 1, locked 1LOCK WAIT 4 lock struct(s), heap size 1128, 3 row lock(s), undo log entries 1MySQL thread id 280, OS thread handle 6136639488, query id 21716 localhost 127.0.0.1 root update/* ApplicationName=DataGrip 2022.3.2 */ insert into child values ('2', 'name2', 2)

*** (1) HOLDS THE LOCK(S):RECORD LOCKS space id 154 page no 4 n bits 72 index PRIMARY of table jpa.child trx id 13034 lock_mode X locks rec but not gapRecord lock, heap no 3 PHYSICAL RECORD: n_fields 5; compact format; info bits 0

*** (1) WAITING FOR THIS LOCK TO BE GRANTED:RECORD LOCKS space id 154 page no 5 n bits 72 index parent_id of table jpa.child trx id 13034 lock_mode X insert intention waitingRecord lock, heap no 1 PHYSICAL RECORD: n_fields 1; compact format; info bits 0

*** (2) TRANSACTION:TRANSACTION 13035, ACTIVE 4 sec insertingmysql tables in use 1, locked 1LOCK WAIT 3 lock struct(s), heap size 1128, 2 row lock(s)MySQL thread id 281, OS thread handle 6135525376, query id 21726 localhost 127.0.0.1 root update/* ApplicationName=DataGrip 2022.3.2 */ insert into child values ('2', 'name2', 2)

*** (2) HOLDS THE LOCK(S):RECORD LOCKS space id 154 page no 5 n bits 72 index parent_id of table jpa.child trx id 13035 lock_mode XRecord lock, heap no 1 PHYSICAL RECORD: n_fields 1; compact format; info bits 0

*** (2) WAITING FOR THIS LOCK TO BE GRANTED:RECORD LOCKS space id 154 page no 4 n bits 72 index PRIMARY of table jpa.child trx id 13035 lock mode S locks rec but not gap waitingRecord lock, heap no 3 PHYSICAL RECORD: n_fields 5; compact format; info bits 0

- SELECT * FROM performance_schema.data_locks;

| INDEX\_NAME | OBJECT\_INSTANCE\_BEGIN | LOCK\_TYPE | LOCK\_MODE | LOCK\_STATUS | LOCK\_DATA |
| :--- | :--- | :--- | :--- | :--- | :--- |
| null | 4813003272 | TABLE | IX | GRANTED | null |
| parent\_id | 4823656472 | RECORD | X | GRANTED | supremum pseudo-record |
| parent\_id | 4823656816 | RECORD | X,INSERT\_INTENTION | GRANTED | supremum pseudo-record |
| parent\_id | 4823657160 | RECORD | X,GAP | GRANTED | 1, 1 |
</details>
